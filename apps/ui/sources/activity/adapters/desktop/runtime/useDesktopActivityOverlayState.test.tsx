import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import { type DesktopActivityOverlayWindowStatePayload } from './desktopActivityOverlayBridge';
import { resolveDesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { useDesktopActivityOverlayState } from './useDesktopActivityOverlayState';

// Native command/event transport is the system boundary; the hook and bridge stay real.
const native = vi.hoisted(() => ({
    isDesktopHost: vi.fn(() => true),
    invoke: vi.fn<(command: string) => Promise<DesktopActivityOverlayWindowStatePayload | null>>(),
    listen: vi.fn<(event: string, handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) => Promise<() => void>>(),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => native.isDesktopHost(),
    invokeDesktopHost: (command: string) => native.invoke(command),
    listenDesktopHostEvent: (event: string, handler: (payload: DesktopActivityOverlayWindowStatePayload) => void) =>
        native.listen(event, handler),
}));

function windowState(overrides: Partial<DesktopActivityOverlayWindowStatePayload> = {}): DesktopActivityOverlayWindowStatePayload {
    const window = { collapsed: { width: 254, height: 38 }, expanded: { width: 408, height: 118 } };
    return {
        visible: true,
        expanded: false,
        model: {
            visible: true,
            isExpanded: false,
            generatedAt: 1,
            collapsed: { title: 'Sessions', statusText: null, defaultTarget: 'open-primary-session', sessionCount: 1 },
            expanded: { title: 'Sessions', rows: [] },
            window,
        },
        policy: resolveDesktopOverlayPolicy({ desktopOverlayEnabled: true }),
        window,
        ...overrides,
    };
}

describe('useDesktopActivityOverlayState', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('window', { location: { href: 'https://happier.test/desktop/activity-overlay' } });
        native.isDesktopHost.mockReturnValue(true);
        native.invoke.mockResolvedValue(windowState());
        native.listen.mockResolvedValue(() => {});
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        native.invoke.mockReset();
        native.listen.mockReset();
    });

    it('catches up changes during listener registration, then stays idle until native events', async () => {
        const subscription = createDeferred<() => void>();
        const initial = windowState();
        const expanded = windowState({ expanded: true });
        native.invoke.mockResolvedValueOnce(initial).mockResolvedValue(expanded);
        native.listen.mockReturnValue(subscription.promise);

        const hook = await renderHook(useDesktopActivityOverlayState);
        expect(hook.getCurrent()).toEqual(initial);

        subscription.resolve(() => {});
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expanded);
        const readsAfterCatchUp = native.invoke.mock.calls.length;

        await flushHookEffects({ cycles: 1, advanceTimersMs: 10_000 });
        expect(native.invoke).toHaveBeenCalledTimes(readsAfterCatchUp);
        expect(native.listen).toHaveBeenCalledWith('activityOverlay://state', expect.any(Function));

        const onState = native.listen.mock.calls[0][1];
        const hidden = windowState({ visible: false });
        await act(async () => onState(hidden));
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(hidden);
    });

    it('runs listener-gap catch-up even while the initial native read was still pending', async () => {
        const initialRead = createDeferred<DesktopActivityOverlayWindowStatePayload>();
        const subscription = createDeferred<() => void>();
        native.invoke.mockReturnValueOnce(initialRead.promise).mockResolvedValue(windowState({ expanded: true }));
        native.listen.mockReturnValue(subscription.promise);
        const hook = await renderHook(useDesktopActivityOverlayState);

        subscription.resolve(() => {});
        await flushHookEffects();
        initialRead.resolve(windowState());
        await flushHookEffects();
        expect(hook.getCurrent()?.expanded).toBe(true);
    });

    it('does not let initial or catch-up snapshots overwrite newer native events', async () => {
        const initialRead = createDeferred<DesktopActivityOverlayWindowStatePayload>();
        const catchUpRead = createDeferred<DesktopActivityOverlayWindowStatePayload>();
        native.invoke.mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(catchUpRead.promise);
        const hook = await renderHook(useDesktopActivityOverlayState);

        const expanded = windowState({ expanded: true });
        await act(async () => native.listen.mock.calls[0][1](expanded));
        await flushHookEffects();
        initialRead.resolve(windowState());
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expanded);

        const hidden = windowState({ visible: false });
        await act(async () => native.listen.mock.calls[0][1](hidden));
        await flushHookEffects();
        catchUpRead.resolve(expanded);
        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(hidden);
    });

    it('retains unchanged snapshot identity for duplicate native publication', async () => {
        const hook = await renderHook(useDesktopActivityOverlayState);
        const current = hook.getCurrent();
        await act(async () => native.listen.mock.calls[0][1](windowState()));
        await flushHookEffects();
        expect(hook.getCurrent()).toBe(current);
    });

    it('disposes a subscription that resolves after unmount without issuing catch-up', async () => {
        const subscription = createDeferred<() => void>();
        native.listen.mockReturnValue(subscription.promise);
        const hook = await renderHook(useDesktopActivityOverlayState);
        await hook.unmount();
        const dispose = vi.fn();
        subscription.resolve(dispose);
        await flushHookEffects();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(native.invoke).toHaveBeenCalledTimes(1);
    });

    it('leaves browser and main-window contexts without native observation', async () => {
        native.isDesktopHost.mockReturnValue(false);
        const browser = await renderHook(useDesktopActivityOverlayState);
        expect(browser.getCurrent()).toBeNull();
        await browser.unmount();
        native.isDesktopHost.mockReturnValue(true);
        vi.stubGlobal('window', { location: { href: 'https://happier.test/' } });
        const main = await renderHook(useDesktopActivityOverlayState);
        expect(main.getCurrent()).toBeNull();
        expect(native.invoke).not.toHaveBeenCalled();
        expect(native.listen).not.toHaveBeenCalled();
    });
});
