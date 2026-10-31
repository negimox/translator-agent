import { EventEmitter } from "events";
import type { ProviderFactory } from "../../src/providers";
import type {
  TranslationRequest,
  TranslationResponse,
  TTSRequest,
  TTSResponse,
} from "../../src/providers/types";

export class FakeSTT extends EventEmitter {
  readonly name = "fake-stt";
  lastOptions?: { languageCode?: string; instanceId?: string };
  async connect(): Promise<void> {}
  sendAudio(_base64Audio: string): void {}
  disconnect(): void {}
}

export interface FakeFactoryOptions {
  translate?: (req: TranslationRequest) => Promise<TranslationResponse>;
  synthesize?: (req: TTSRequest) => Promise<TTSResponse>;
}

export function makeFakeFactory(opts: FakeFactoryOptions = {}) {
  const stt = new FakeSTT();
  const translateCalls: TranslationRequest[] = [];
  const ttsCalls: TTSRequest[] = [];

  const translation = {
    name: "fake-translation",
    supportedLanguagePairs: [],
    supportsLanguagePair: () => true,
    checkHealth: async () => ({ healthy: true }),
    translate: async (req: TranslationRequest) => {
      translateCalls.push(req);
      return opts.translate
        ? opts.translate(req)
        : { text: "translated", detectedSourceLanguage: undefined };
    },
  };
  const tts = {
    name: "fake-tts",
    supportedLanguages: [],
    checkHealth: async () => ({ healthy: true }),
    synthesize: async (req: TTSRequest) => {
      ttsCalls.push(req);
      return opts.synthesize
        ? opts.synthesize(req)
        : { audioBuffer: new ArrayBuffer(4), contentType: "audio/mpeg" };
    },
  };

  const factory = {
    getSTTProvider: (
      _type: string,
      options?: { languageCode?: string; instanceId?: string },
    ) => {
      stt.lastOptions = options;
      return stt;
    },
    getTranslationProvider: () => translation,
    getTTSProvider: () => tts,
  } as unknown as ProviderFactory;

  return { factory, stt, translateCalls, ttsCalls };
}

/** Lets fire-and-forget async handlers settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
