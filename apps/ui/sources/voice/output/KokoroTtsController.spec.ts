import { describe, expect, it, vi } from 'vitest';

vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({
  isKokoroRuntimeSupported: () => true,
}));

const playAudioBytesWithStopperSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (opts: any) => playAudioBytesWithStopperSpy(opts),
}));

const streamKokoroWavSentencesSpy = vi.fn(
  ({ signal }: { signal: AbortSignal }) =>
    ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    }) as AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }>,
);
const synthesizeKokoroWavSpy = vi.fn(async (_opts: any) => new Uint8Array([0]).buffer);
vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  synthesizeKokoroWav: (opts: any) => synthesizeKokoroWavSpy(opts),
  streamKokoroWavSentences: (opts: any) => streamKokoroWavSentencesSpy(opts),
}));

import { speakKokoroText } from '@/voice/output/KokoroTtsController';

describe('speakKokoroText', () => {
  it('treats a deliberate stop as completion, not as a failure', async () => {
    let registeredStopper: (() => void) | null = null;
    const registerPlaybackStopper = (stopper: () => void) => {
      registeredStopper = stopper;
      return () => {};
    };

    const promise = speakKokoroText({
      text: 'hello',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper,
    });

    expect(typeof registeredStopper).toBe('function');
    registeredStopper!();

    await expect(promise).resolves.toBeUndefined();
    expect(playAudioBytesWithStopperSpy).not.toHaveBeenCalled();
  });

  it('plays sentence wavs sequentially', async () => {
    const a = new Uint8Array([1]).buffer;
    const b = new Uint8Array([2]).buffer;

    streamKokoroWavSentencesSpy.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield { wavBytes: a, sentenceText: 'a' };
        yield { wavBytes: b, sentenceText: 'b' };
      },
    }));

    await speakKokoroText({
      text: 'hello world',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
    });

    expect(playAudioBytesWithStopperSpy).toHaveBeenCalledTimes(2);
    expect(playAudioBytesWithStopperSpy.mock.calls[0]?.[0]?.bytes).toBe(a);
    expect(playAudioBytesWithStopperSpy.mock.calls[1]?.[0]?.bytes).toBe(b);
  });

  it('rejects when synthesis fails without being stopped', async () => {
    streamKokoroWavSentencesSpy.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('model_pack_not_installed');
      },
    }));

    await expect(
      speakKokoroText({
        text: 'hello',
        voiceId: null,
        speed: 1,
        timeoutMs: 15000,
        registerPlaybackStopper: () => () => {},
      }),
    ).rejects.toThrow('model_pack_not_installed');
  });
});
