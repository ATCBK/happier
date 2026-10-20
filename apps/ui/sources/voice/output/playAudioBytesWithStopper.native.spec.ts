import { describe, expect, it, vi } from 'vitest';

const fileDelete = vi.fn(() => new Promise<void>(() => {}));
const playbackState: {
  playbackStatusListener: ((status: any) => void) | null;
} = {
  playbackStatusListener: null,
};

async function waitForPlaybackStatusListener() {
  await vi.waitFor(() => {
    expect(playbackState.playbackStatusListener).toBeTruthy();
  });
}

async function waitForFileDeleteCall() {
  await vi.waitFor(() => {
    expect(fileDelete).toHaveBeenCalled();
  });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'ios',
                    },
                }
    );
});

vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///tmp/' },
  File: class {
    uri: string;
    constructor(base: string, name: string) {
      this.uri = `${base}${name}`;
    }
    async write(_content: Uint8Array) {}
    delete = fileDelete;
  },
}));

vi.mock('expo-audio', () => ({
  createAudioPlayer: (_source?: string) => ({
    addListener: (_event: string, cb: (status: any) => void) => {
      playbackState.playbackStatusListener = cb;
      return { remove() {} };
    },
    play: () => undefined,
    remove() {},
  }),
}));

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';

describe('playAudioBytesWithStopper (native)', () => {
  it('resolves promptly when playback finishes even if temp-file cleanup stalls', async () => {
    playbackState.playbackStatusListener = null;
    fileDelete.mockClear();

    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      format: 'mp3',
      registerPlaybackStopper: () => () => {},
    });

    await waitForPlaybackStatusListener();

    const notifyPlaybackFinished: (status: any) => void = playbackState.playbackStatusListener ?? (() => {
      throw new Error('Expected playback status listener to be registered');
    });
    let resolved = false;
    const observedResolution = promise.then(() => {
      resolved = true;
    });
    notifyPlaybackFinished({ didJustFinish: true });

    await vi.waitFor(() => {
      expect(resolved).toBe(true);
    });
    await observedResolution;

    await waitForFileDeleteCall();
    expect(fileDelete).toHaveBeenCalledTimes(1);
  });

  function startPlayback() {
    playbackState.playbackStatusListener = null;
    let settled: 'resolved' | 'rejected' | null = null;
    let rejection: unknown = null;
    const promise = playAudioBytesWithStopper({
      bytes: new Uint8Array([1]).buffer,
      format: 'wav',
      registerPlaybackStopper: () => () => {},
    }).then(
      () => {
        settled = 'resolved';
      },
      (error) => {
        settled = 'rejected';
        rejection = error;
      },
    );
    return {
      promise,
      emit: (status: any) => playbackState.playbackStatusListener?.(status),
      settled: () => settled,
      rejection: () => rejection,
    };
  }

  it('rejects when the player reports a failed item (iOS)', async () => {
    const playback = startPlayback();
    await waitForPlaybackStatusListener();

    playback.emit({ playbackState: 'failed', playing: false, didJustFinish: false, isBuffering: false });

    await vi.waitFor(() => expect(playback.settled()).toBe('rejected'));
    expect(String((playback.rejection() as Error)?.message)).toContain('audio_playback_failed');
  });

  it('rejects when the player drops back to idle after loading (Android player error)', async () => {
    const playback = startPlayback();
    await waitForPlaybackStatusListener();

    playback.emit({ playbackState: 'ready', playing: true, didJustFinish: false, isBuffering: false });
    playback.emit({ playbackState: 'idle', playing: false, didJustFinish: false, isBuffering: false });

    await vi.waitFor(() => expect(playback.settled()).toBe('rejected'));
  });

  it('ends playback when the system pauses it (audio focus loss) instead of waiting forever', async () => {
    const playback = startPlayback();
    await waitForPlaybackStatusListener();

    playback.emit({ playbackState: 'ready', playing: true, didJustFinish: false, isBuffering: false });
    playback.emit({ playbackState: 'ready', playing: false, didJustFinish: false, isBuffering: false });

    await vi.waitFor(() => expect(playback.settled()).toBe('resolved'));
  });

  it('keeps waiting while the player is still loading', async () => {
    const playback = startPlayback();
    await waitForPlaybackStatusListener();

    playback.emit({ playbackState: 'idle', playing: false, didJustFinish: false, isBuffering: false, isLoaded: false });
    playback.emit({ playbackState: 'buffering', playing: false, didJustFinish: false, isBuffering: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(playback.settled()).toBe(null);

    playback.emit({ didJustFinish: true });
    await vi.waitFor(() => expect(playback.settled()).toBe('resolved'));
  });
});
