import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
import { useCanvasRenderState } from './useCanvasRenderState';

const boundary = vi.hoisted(() => ({ state: null as ReturnType<typeof createReactNativeAppStateEmitter> | null }));
vi.mock('react-native', async () => {
    const kit = await import('@/dev/testkit/mocks/reactNative');
    boundary.state = kit.createReactNativeAppStateEmitter('active');
    return kit.createReactNativeWebMock({ AppState: boundary.state.appState });
});

describe('canvas work admission', () => {
    afterEach(() => vi.useRealTimers());
    it('shows the initial box immediately and coalesces resize work after 120ms', async () => {
        vi.useFakeTimers();
        const hook = await renderHook(useCanvasRenderState, { initialProps: { width: 390, height: 844 } });
        expect(hook.getCurrent()).toEqual({ visible: true, size: { width: 390, height: 844 } });
        await hook.rerender({ width: 400, height: 844 });
        await act(async () => { vi.advanceTimersByTime(119); });
        expect(hook.getCurrent().size.width).toBe(390);
        await hook.rerender({ width: 420, height: 844 });
        await act(async () => { vi.advanceTimersByTime(120); });
        expect(hook.getCurrent().size.width).toBe(420);
        await hook.unmount();
    });
    it('pauses work while hidden and catches up with the latest box on return', async () => {
        vi.useFakeTimers();
        const hook = await renderHook(useCanvasRenderState, { initialProps: { width: 390, height: 844 } });
        await act(async () => { boundary.state!.emit('background'); });
        await hook.rerender({ width: 500, height: 844 });
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(hook.getCurrent()).toEqual({ visible: false, size: { width: 390, height: 844 } });
        await act(async () => { boundary.state!.emit('active'); vi.advanceTimersByTime(120); });
        await act(async () => { vi.advanceTimersByTime(120); });
        expect(hook.getCurrent()).toEqual({ visible: true, size: { width: 500, height: 844 } });
        await hook.unmount();
    });
});
