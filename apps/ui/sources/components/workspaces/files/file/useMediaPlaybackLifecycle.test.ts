import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { useMediaPlaybackLifecycle } from './useMediaPlaybackLifecycle';

describe('useMediaPlaybackLifecycle', () => {
    it('pauses the media player when voice output starts and does not resume it automatically', async () => {
        const pause = vi.fn(); // The native/HTML media player is the system boundary.
        const hook = await renderHook(() => useMediaPlaybackLifecycle({ isActive: true, isFullscreen: false, pause }));
        let output!: ReturnType<typeof voiceRuntimeLevelStore.open>;
        await act(async () => { output = voiceRuntimeLevelStore.open({ channel: 'output', sourceId: 'file-media-test' }); });
        onTestFinished(() => output.close());
        expect(pause).toHaveBeenCalled();
        expect(hook.getCurrent().voiceOutputActive).toBe(true);
        await act(async () => { output.close(); });
        expect(hook.getCurrent().voiceOutputActive).toBe(false);
        await hook.unmount();
    });

    it('pauses when its body becomes inactive and stops before unmount', async () => {
        const pause = vi.fn();
        const hook = await renderHook(({ isActive }) => useMediaPlaybackLifecycle({ isActive, isFullscreen: false, pause }), {
            initialProps: { isActive: true },
        });
        expect(hook.getCurrent().enabled).toBe(true);
        await hook.rerender({ isActive: false });
        expect(hook.getCurrent().enabled).toBe(false);
        expect(pause).toHaveBeenCalled();
        pause.mockClear();
        await hook.unmount();
        expect(pause).toHaveBeenCalled();
    });
});
