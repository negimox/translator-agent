/**
 * Chrome Launcher module for Puppeteer with required flags.
 * Sets up headless Chrome with autoplay and media permissions enabled.
 */

import puppeteer, { Browser, Page } from 'puppeteer';
import { AgentConfig } from '../config';
import { createLogger } from '../logger';

const logger = createLogger('ChromeLauncher');

/**
 * Required Chrome flags for the translator agent.
 * These are critical for proper WebRTC and audio operation.
 */
export const REQUIRED_CHROME_FLAGS: string[] = [
    // Critical: Enable autoplay without user gesture (required for AudioContext)
    '--autoplay-policy=no-user-gesture-required',
    
    // Auto-allow getUserMedia in headless mode (required for media access)
    '--use-fake-ui-for-media-stream',
    
    // Create fake audio/video devices (critical for headless bots)
    '--use-fake-device-for-media-stream',
    
    // Disable GPU for headless stability
    '--disable-gpu',
    '--disable-software-rasterizer',
    
    // Required in containerized environments (Docker, K8s)
    '--no-sandbox',
    '--disable-setuid-sandbox',
    
    // Reduce resource usage
    '--disable-dev-shm-usage',
    
    // Disable unnecessary features for a bot
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    
    // Audio-specific optimizations
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    
    // WebRTC-specific
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    
    // Audio output - use PulseAudio
    '--alsa-output-device=pulse',
];

/**
 * Permissions to grant to the page.
 */
export const REQUIRED_PERMISSIONS = [
    'microphone',
    'camera',
    'notifications',
] as const;

/**
 * Result of launching Chrome.
 */
export interface ChromeInstance {
    browser: Browser;
    page: Page;
    close: () => Promise<void>;
}

import { existsSync } from 'fs';

/**
 * Common Chromium/Chrome paths on Linux systems.
 */
const SYSTEM_CHROMIUM_PATHS = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
];

/**
 * Finds system-installed Chromium/Chrome.
 * Returns the path if found, undefined otherwise.
 */
function findSystemChromium(): string | undefined {
    for (const chromePath of SYSTEM_CHROMIUM_PATHS) {
        if (existsSync(chromePath)) {
            logger.debug('Found system Chromium', { path: chromePath });
            return chromePath;
        }
    }
    logger.debug('No system Chromium found, will use bundled');
    return undefined;
}

/**
 * Launches a Puppeteer-controlled Chrome instance with the required flags.
 * 
 * @param config - Agent configuration
 * @returns ChromeInstance with browser, page, and cleanup function
 */
export async function launchChrome(config: AgentConfig): Promise<ChromeInstance> {
    logger.info('Launching Chrome with required flags', {
        headless: config.chromeHeadless,
        devtools: config.chromeDevtools,
    });

    // Determine which browser executable to use
    // Priority: PUPPETEER_EXECUTABLE_PATH env var > system chromium > bundled
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
        findSystemChromium();
    
    if (executablePath) {
        logger.info('Using custom Chrome/Chromium path', { executablePath });
    }

    const launchOptions = {
        // Use 'true' for headless mode (more compatible than 'shell')
        headless: config.chromeHeadless,
        devtools: config.chromeDevtools,
        args: REQUIRED_CHROME_FLAGS,
        // Use system Chrome if specified
        ...(executablePath && { executablePath }),
        // Default viewport for the agent
        defaultViewport: {
            width: 1280,
            height: 720,
        },
        // PulseAudio: Route Chrome audio to virtual sink
        env: {
            ...process.env,
            PULSE_SINK: 'translator_sink',  // Chrome outputs to this sink
        },
        // Ignore HTTPS errors (useful for self-signed certs in dev)
        acceptInsecureCerts: true,
        // Enable for debugging browser launch issues
        dumpio: process.env.DEBUG_CHROME === 'true',
    };

    logger.debug('Launch options configured', { 
        flags: REQUIRED_CHROME_FLAGS.slice(0, 5),
        flagCount: REQUIRED_CHROME_FLAGS.length 
    });

    let browser: Browser;
    try {
        browser = await puppeteer.launch(launchOptions);
    } catch (launchError) {
        // Provide more helpful error message
        const errorMsg = launchError instanceof Error ? launchError.message : String(launchError);
        logger.error('Chrome launch failed', { 
            error: errorMsg,
            hint: 'Try running: npx puppeteer browsers install chrome',
        });
        throw new Error(`Failed to launch Chrome: ${errorMsg}`);
    }

    logger.info('Chrome browser launched successfully');

    // Get or create the first page
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Grant permissions for the Jitsi domain
    const jitsiOrigin = `https://${config.jitsiDomain}`;
    try {
        const context = browser.defaultBrowserContext();
        await context.overridePermissions(jitsiOrigin, [...REQUIRED_PERMISSIONS]);
        logger.info('Permissions granted for Jitsi domain', { origin: jitsiOrigin });
    } catch (error) {
        logger.warn('Failed to override permissions (may not be critical)', { 
            error: String(error) 
        });
    }

    // Set up console message forwarding
    page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        
        // Only log non-trivial messages
        if (text && !text.includes('[object Object]')) {
            switch (type) {
                case 'error':
                    logger.error(`[Browser] ${text}`);
                    break;
                case 'warn':
                    logger.warn(`[Browser] ${text}`);
                    break;
                case 'info':
                case 'log':
                    logger.debug(`[Browser] ${text}`);
                    break;
            }
        }
    });

    // Handle page errors
    page.on('pageerror', (error) => {
        logger.error('Page error occurred', { error: (error as Error).message });
    });

    // Handle request failures (useful for debugging)
    page.on('requestfailed', (request) => {
        const url = request.url();
        // Only log significant failures (skip tracking/analytics)
        if (!url.includes('analytics') && !url.includes('tracking')) {
            logger.debug('Request failed', { 
                url: url.slice(0, 100), 
                reason: request.failure()?.errorText 
            });
        }
    });

    const close = async (): Promise<void> => {
        logger.info('Closing Chrome browser');
        try {
            await browser.close();
            logger.info('Chrome browser closed successfully');
        } catch (error) {
            logger.error('Error closing browser', { error: String(error) });
        }
    };

    return { browser, page, close };
}

/**
 * Checks if the Chrome instance is still running.
 */
export function isChromeLive(instance: ChromeInstance): boolean {
    try {
        return instance.browser.connected;
    } catch {
        return false;
    }
}
