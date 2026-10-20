import { describe, expect, it, vi } from 'vitest';

const playSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (...args: any[]) => playSpy(...args),
}));

describe('speakGoogleCloudText', () => {
  it('synthesizes audio via Google Cloud TTS and plays it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audioContent: 'Zm9v' }), // "foo"
    });
    (globalThis as any).fetch = fetchSpy;

    const { speakGoogleCloudText } = await import('./GoogleCloudTtsController');
    await speakGoogleCloudText({
      apiKey: 'k',
      androidCertSha1: null,
      input: 'hello',
      voiceName: 'en-US-Wavenet-D',
      languageCode: 'en-US',
      format: 'mp3',
      speakingRate: null,
      pitch: null,
      timeoutMs: 15000,
      registerPlaybackStopper: (_stopper) => () => {},
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('texttospeech.googleapis.com'),
      expect.objectContaining({
        method: 'POST',
      }),
    );

    const call = fetchSpy.mock.calls[0]!;
    const init = call[1] as any;
    const body = JSON.parse(String(init.body));
    expect(body.audioConfig.audioEncoding).toBe('MP3');

    expect(playSpy).toHaveBeenCalled();
    const played = playSpy.mock.calls[0]![0];
    expect(played.format).toBe('mp3');
    expect(new Uint8Array(played.bytes)).toEqual(new Uint8Array([102, 111, 111]));
  });

  it('does not play audio when stopped while the synthesis request is in flight', async () => {
    playSpy.mockClear();
    const fetchSpy = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    (globalThis as any).fetch = fetchSpy;

    let stopper: (() => void) | null = null;
    const { speakGoogleCloudText } = await import('./GoogleCloudTtsController');
    const promise = speakGoogleCloudText({
      apiKey: 'k',
      androidCertSha1: null,
      input: 'hello',
      voiceName: null,
      languageCode: null,
      format: 'mp3',
      speakingRate: null,
      pitch: null,
      timeoutMs: 15000,
      registerPlaybackStopper: (s) => {
        stopper = s;
        return () => {};
      },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    stopper!();

    await expect(promise).resolves.toBeUndefined();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it('splits long input so every request stays within the 5000-byte API limit', async () => {
    playSpy.mockClear();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ audioContent: 'Zm9v' }) });
    (globalThis as any).fetch = fetchSpy;

    const sentence = 'Das Wetter ist heute schön und überall ruhig. ';
    const input = sentence.repeat(200);
    const { speakGoogleCloudText } = await import('./GoogleCloudTtsController');
    await speakGoogleCloudText({
      apiKey: 'k',
      androidCertSha1: null,
      input,
      voiceName: null,
      languageCode: null,
      format: 'mp3',
      speakingRate: null,
      pitch: null,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
    });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    const sentTexts = fetchSpy.mock.calls.map((call) => JSON.parse(String((call[1] as any).body)).input.text as string);
    for (const text of sentTexts) {
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(5000);
    }
    expect(sentTexts.join(' ')).toBe(input.trim());
    expect(playSpy).toHaveBeenCalledTimes(sentTexts.length);
  });
});
