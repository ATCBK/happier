import { beforeEach, describe, expect, it, vi } from 'vitest';

// Boundaries only: platform speech (expo-speech), audio player (expo-audio), file system,
// network (fetch), secret decryption, and the Kokoro synthesis runtime (native module / web worker).
const speech = vi.hoisted(() => ({
  speak: vi.fn<(text: string, options: any) => void>(),
  stop: vi.fn<() => void>(),
}));
vi.mock('expo-speech', () => ({
  speak: (text: string, options: any) => speech.speak(text, options),
  stop: () => speech.stop(),
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemMock().module;
});

const playedSources = vi.hoisted(() => [] as string[]);
vi.mock('expo-audio', () => ({
  createAudioPlayer: (source: string) => {
    let listener: ((status: unknown) => void) | null = null;
    playedSources.push(source);
    return {
      addListener: (_event: string, cb: (status: unknown) => void) => {
        listener = cb;
        return { remove() {} };
      },
      play: () => {
        queueMicrotask(() => listener?.({ didJustFinish: true }));
      },
      remove() {},
    };
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: { decryptSecretValue: (value: unknown) => (value ? 'secret-key' : null) },
}));

const kokoroRuntime = vi.hoisted(() => ({
  stream: vi.fn<(opts: any) => AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }>>(),
}));
vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({ isKokoroRuntimeSupported: () => true }));
vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  streamKokoroWavSentences: (opts: any) => kokoroRuntime.stream(opts),
}));

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { createTtsChunker } from '@/voice/output/TtsChunker';
import { getLocalVoiceState, patchLocalVoiceState } from '@/voice/local/localVoiceState';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();

beforeEach(() => {
  patchLocalVoiceState({ error: null });
  speech.speak.mockReset().mockImplementation((_text, options) => options?.onDone?.());
  speech.stop.mockReset();
  playedSources.length = 0;
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
  kokoroRuntime.stream.mockReset().mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield { wavBytes: new Uint8Array([1]).buffer, sentenceText: 'hello' };
    },
  }));
});

function settingsWithTts(tts: Record<string, unknown>) {
  return {
    voice: {
      providerId: 'local_direct',
      adapters: {
        local_direct: {
          tts: {
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
            autoSpeakReplies: true,
            bargeInEnabled: true,
            ...tts,
          },
        },
      },
    },
  };
}

const GOOGLE_TTS = {
  provider: 'google_cloud',
  googleCloud: {
    apiKey: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } },
    voiceName: 'en-US-Wavenet-D',
    languageCode: 'en-US',
    format: 'mp3',
    speakingRate: null,
    pitch: null,
  },
};

const OPENAI_TTS = {
  provider: 'openai_compat',
  openaiCompat: { baseUrl: 'http://example.com/v1', apiKey: null, model: 'm', voice: 'v', format: 'wav' },
};

async function speak(text: string, tts: Record<string, unknown>, registerPlaybackStopper = (_s: () => void) => () => {}) {
  return await speakAssistantText({
    text,
    settings: settingsWithTts(tts),
    networkTimeoutMs: 15000,
    registerPlaybackStopper,
    onSpeaking: vi.fn(),
  });
}

describe('speakAssistantText', () => {
  it.each([
    ['Call `f(*args, **kwargs)` and then **continue speaking**.', 'Call f(*args, **kwargs) and then continue speaking.'],
    [`${'a'.repeat(31)}\`\`f(*args, \`literal\`, **kwargs)\`\` then **done**.`, `${'a'.repeat(31)}f(*args, \`literal\`, **kwargs) then done.`],
  ])('preserves inline code across supported streamed cuts: %s', async (text, expected) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    for (const chunk of [...chunker.push(text), ...chunker.flush()]) {
      await speakAssistantText({
        text: chunk,
        speechTextContext,
        settings: settingsWithTts({ provider: 'device' }),
        networkTimeoutMs: 15000,
        registerPlaybackStopper: () => () => {},
        onSpeaking: () => {},
      });
    }
    expect(speech.speak.mock.calls.map(([spoken]) => spoken).join('').replace(/\s+/gu, ''))
      .toBe(expected.replace(/\s+/gu, ''));
  });

  it.each([
    [`**${'a'.repeat(29)}**`, 'a'.repeat(29)],
    [`${'a'.repeat(32)}_count`, `${'a'.repeat(32)}_count`],
    [`${'a'.repeat(31)}_count`, `${'a'.repeat(31)}_count`],
    [`${'a'.repeat(31)} _count_`, `${'a'.repeat(31)}count`],
  ])('preserves delimiter meaning at the streaming hard cut: %s', async (text, expected) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    for (const chunk of [...chunker.push(text), ...chunker.flush()]) {
      await speakAssistantText({
        text: chunk,
        speechTextContext,
        settings: settingsWithTts({ provider: 'device' }),
        networkTimeoutMs: 15000,
        registerPlaybackStopper: () => () => {},
        onSpeaking: () => {},
      });
    }
    expect(speech.speak.mock.calls.map(([spoken]) => spoken).join('')).toBe(expected);
  });

  it.each(['**', '*', '__', '_', '~~'])('keeps %s emphasis out of speech across streamed chunks without delaying ready prose', async (marker) => {
    const chunker = createTtsChunker(32);
    const speechTextContext = { emphasis: [] };
    const first = 'Hello. This sentence continues inside the same emphasis. ';
    const last = 'World.';
    const literals = ' Use *.ts and **/*.ts and file* with max_retry_count and 2 * 3.';
    const speakChunks = async (chunks: readonly string[]) => {
      for (const text of chunks) {
        await speakAssistantText({
          text,
          speechTextContext,
          settings: settingsWithTts({ provider: 'device' }),
          networkTimeoutMs: 15000,
          registerPlaybackStopper: () => () => {},
          onSpeaking: () => {},
        });
      }
    };

    await speakChunks(chunker.push(`${marker}${first}`));
    expect(speech.speak.mock.calls.length).toBeGreaterThan(0);
    expect(speech.speak.mock.calls.map(([text]) => text).join(' ')).not.toContain(marker);
    await speakChunks([...chunker.push(`${last}${marker}${literals}`), ...chunker.flush()]);

    expect(speech.speak.mock.calls.map(([text]) => text).join(' ')).toBe(`${first}${last}${literals}`);
  });

  it('speaks with device speech', async () => {
    await speak('hello', { provider: 'device' });

    expect(speech.speak).toHaveBeenCalledWith('hello', expect.anything());
    expect(getLocalVoiceState().error).toBe(null);
  });

  it('does not report a failure when device speech is stopped (web cancel fires onerror)', async () => {
    let stopper: (() => void) | null = null;
    speech.speak.mockImplementation(() => {});
    speech.stop.mockImplementation(() => {
      // Browsers report speechSynthesis.cancel() as an 'interrupted'/'canceled' utterance error.
      const options = speech.speak.mock.calls.at(-1)?.[1];
      options?.onError?.(new Error('interrupted'));
    });

    const done = speak('hello', { provider: 'device' }, (s) => {
      stopper = s;
      return () => {};
    });
    await vi.waitFor(() => expect(stopper).toBeTruthy());
    stopper!();

    await expect(done).resolves.toBe(true);
    expect(getLocalVoiceState()).toMatchObject({ error: null, errorMessage: null });
  });

  it('reports a device speech error that was not caused by a stop', async () => {
    speech.speak.mockImplementation((_text, options) => options?.onError?.(new Error('synthesis-failed')));

    await expect(speak('hello', { provider: 'device' })).resolves.toBe(false);
    expect(getLocalVoiceState()).toMatchObject({ error: 'tts_failed', errorMessage: 'synthesis-failed' });
  });

  it('synthesizes and plays OpenAI-compatible speech', async () => {
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer });

    await speak('hello', OPENAI_TTS);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('http://example.com/v1');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ input: 'hello', model: 'm', voice: 'v' }));
    expect(playedSources.length).toBe(1);
  });

  it('reports cloud TTS failures in the local voice state', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await speak('hello', OPENAI_TTS);

    expect(playedSources.length).toBe(0);
    expect(getLocalVoiceState()).toMatchObject({ error: 'tts_failed', errorMessage: 'tts_failed:500' });
  });

  it('synthesizes and plays Google Cloud speech', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ audioContent: 'Zm9v' }) });

    await speak('hello', GOOGLE_TTS);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('texttospeech.googleapis.com');
    expect(playedSources.length).toBe(1);
    expect(getLocalVoiceState().error).toBe(null);
  });

  it('reports a Kokoro failure instead of silently switching to the device voice', async () => {
    kokoroRuntime.stream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('model_pack_not_installed');
      },
    }));

    await speak('hello', {
      provider: 'local_neural',
      localNeural: { model: 'kokoro', assetId: 'kokoro-82m', voiceId: 'af_heart', speed: 1 },
    });

    expect(speech.speak).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({ error: 'tts_failed', errorMessage: 'model_pack_not_installed' });
  });

  it('passes no Kokoro voice when none is configured so each platform picks its own default', async () => {
    await speak('hello', {
      provider: 'local_neural',
      localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
    });

    expect(kokoroRuntime.stream).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', voiceId: null }));
    expect(playedSources.length).toBe(1);
  });

  it('speaks plain text instead of markdown and code', async () => {
    await speak('**Done.** See [the PR](https://github.com/x/y/pull/1).\n```ts\nconst a = 1;\n```', { provider: 'device' });

    expect(speech.speak).toHaveBeenCalledWith('Done. See the PR.', expect.anything());
  });

  it('does not speak a reply that is only code', async () => {
    await speak('```sh\nls -la\n```', { provider: 'device' });

    expect(speech.speak).not.toHaveBeenCalled();
  });
});
