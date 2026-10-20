import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { useFileAudioPlayer } from './useFileAudioPlayer.web';

// HTMLAudioElement is the browser boundary. Events exercise the real player controller.
class BrowserAudio extends EventTarget {
    static instances: BrowserAudio[] = [];
    currentTime = 0;
    duration = 30;
    paused = true;
    ended = false;
    readyState = 0;
    error: { code: number; message: string } | null = null;
    src: string;
    preload = '';
    play = vi.fn(async () => { this.paused = false; this.dispatchEvent(new Event('play')); });
    pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')); });
    load = vi.fn();
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
    constructor(uri: string) { super(); this.src = uri; BrowserAudio.instances.push(this); }
}

afterEach(() => { BrowserAudio.instances = []; vi.unstubAllGlobals(); });

describe('file audio browser controller', () => {
    it('seeks in seconds and pauses on real voice output activity', async () => {
        vi.stubGlobal('Audio', BrowserAudio);
        const hook = await renderHook(() => useFileAudioPlayer({ uri: 'blob:song', isActive: true }));
        const audio = BrowserAudio.instances[0]!;
        await act(async () => { audio.readyState = 2; audio.dispatchEvent(new Event('loadedmetadata')); });
        await act(async () => { await hook.getCurrent().play(); await hook.getCurrent().seekTo(28); await hook.getCurrent().seekBy(5); });
        expect(audio.currentTime).toBe(30);
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', playing: true, duration: 30 });
        let voice!: ReturnType<typeof voiceRuntimeLevelStore.open>;
        await act(async () => { voice = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'audio-player-test' }); });
        onTestFinished(() => voice.close());
        expect(audio.paused).toBe(true);
        expect(hook.getCurrent().playbackAllowed).toBe(false);
        await act(async () => { voice.close(); });
        expect(audio.paused).toBe(true);
        await hook.unmount();
        expect(audio.src).toBe('');
    });

    it('reports decoder failure and retires a changed URI without owning or revoking it', async () => {
        vi.stubGlobal('Audio', BrowserAudio);
        const hook = await renderHook(({ uri }) => useFileAudioPlayer({ uri, isActive: true }), { initialProps: { uri: 'blob:a' } });
        const first = BrowserAudio.instances[0]!;
        await act(async () => { first.error = { code: 3, message: 'unsupported codec' }; first.dispatchEvent(new Event('error')); });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: 'unsupported codec' });
        await hook.rerender({ uri: 'blob:b' });
        expect(first.src).toBe('');
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', error: null });
        await hook.unmount();
    });
});
