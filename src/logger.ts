/**
 * Simple logger utility for the translator agent.
 * Supports log levels and structured output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

/**
 * Logger class with level-based filtering and structured output.
 */
class Logger {
    private minLevel: number;
    private component: string;

    constructor(component: string = 'Agent') {
        this.component = component;
        // Get log level from environment, default to 'info'
        const logLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
        this.minLevel = LOG_LEVELS[logLevel] ?? LOG_LEVELS.info;
    }

    /**
     * Creates a child logger with a specific component name.
     */
    child(component: string): Logger {
        return new Logger(component);
    }

    /**
     * Updates the minimum log level.
     */
    setLevel(level: LogLevel): void {
        this.minLevel = LOG_LEVELS[level];
    }

    private formatMessage(level: LogLevel, message: string, data?: Record<string, unknown>): string {
        const timestamp = new Date().toISOString();
        const dataStr = data ? ` ${JSON.stringify(data)}` : '';
        return `[${timestamp}] [${level.toUpperCase()}] [${this.component}] ${message}${dataStr}`;
    }

    private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
        if (LOG_LEVELS[level] >= this.minLevel) {
            const formatted = this.formatMessage(level, message, data);
            switch (level) {
                case 'error':
                    console.error(formatted);
                    break;
                case 'warn':
                    console.warn(formatted);
                    break;
                default:
                    console.log(formatted);
            }
        }
    }

    debug(message: string, data?: Record<string, unknown>): void {
        this.log('debug', message, data);
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.log('info', message, data);
    }

    warn(message: string, data?: Record<string, unknown>): void {
        this.log('warn', message, data);
    }

    error(message: string, data?: Record<string, unknown>): void {
        this.log('error', message, data);
    }
}

// Default logger instance
export const logger = new Logger();

// Factory function for component-specific loggers
export function createLogger(component: string): Logger {
    return new Logger(component);
}
