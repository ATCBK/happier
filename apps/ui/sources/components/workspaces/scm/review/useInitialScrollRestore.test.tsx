import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MutableRefObject } from 'react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                Platform: {
                    OS: 'web',
                    select: (value: any) => value?.default ?? null,
                },
            }
    );
});

import { useInitialScrollRestore } from '@/components/workspaces/scm/review/useInitialScrollRestore';
import { renderHook } from '@/dev/testkit';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

beforeEach(() => {
    vi.useFakeTimers();
});

type InitialScrollRestoreHarnessProps = Readonly<{
    initial: number | null;
    latestScrollTopRef: MutableRefObject<number>;
    applyInitialScrollTop: (top: number) => boolean;
}>;

async function renderInitialScrollRestoreHarness(props: InitialScrollRestoreHarnessProps) {
    return renderHook(({ initial, latestScrollTopRef, applyInitialScrollTop }: InitialScrollRestoreHarnessProps) => {
        useInitialScrollRestore({
            initialScrollTop: initial,
            latestScrollTopRef,
            applyInitialScrollTop,
            maxAttempts: 3,
        });
        return null;
    }, {
        initialProps: props,
        flushOptions: { cycles: 0 },
    });
}

async function advanceRestoreTimers(times = 1): Promise<void> {
    await act(async () => {
        for (let index = 0; index < times; index += 1) {
            await vi.advanceTimersToNextTimerAsync();
        }
    });
}

describe('useInitialScrollRestore', () => {
    it('restores a saved position already retained by the scroll tracker on remount', async () => {
        const scrollTopRef = { current: 300 };
        const apply = vi.fn(() => true);

        await renderInitialScrollRestoreHarness({
            initial: 300,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers();

        expect(apply.mock.calls).toEqual([[300]]);
    });

    it('restores on mount without jumping again when the persisted seed follows a reader scroll', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        const hook = await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers();

        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(1200);

        act(() => { scrollTopRef.current = 1800; });
        await hook.rerender({ initial: 1800, latestScrollTopRef: scrollTopRef, applyInitialScrollTop: apply });
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });

        expect(scrollTopRef.current).toBe(1800);
        expect(apply.mock.calls).toEqual([[1200]]);
    });

    it('does not apply initial scroll if user scrolls before restore fires', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => true);

        await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        act(() => {
            scrollTopRef.current = 250;
        });

        await advanceRestoreTimers();

        expect(apply).toHaveBeenCalledTimes(0);
    });

    it('does not restore after the reader returns to the top before the scheduled restore', async () => {
        const scrollTopRef = { current: 300 };
        const apply = vi.fn(() => true);
        await renderInitialScrollRestoreHarness({
            initial: 300,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        act(() => { scrollTopRef.current = 0; });
        await advanceRestoreTimers();

        expect(apply).not.toHaveBeenCalled();
    });

    it('retries until apply succeeds or attempts exhausted', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);

        await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        await advanceRestoreTimers(3);

        expect(apply).toHaveBeenCalledTimes(3);
        expect(apply).toHaveBeenLastCalledWith(1200);
    });

    it('cancels pending restore timers on unmount', async () => {
        const scrollTopRef = { current: 0 };
        const apply = vi.fn(() => false);
        const hook = await renderInitialScrollRestoreHarness({
            initial: 1200,
            latestScrollTopRef: scrollTopRef,
            applyInitialScrollTop: apply,
        });

        expect(vi.getTimerCount()).toBeGreaterThan(0);

        await hook.unmount();

        expect(vi.getTimerCount()).toBe(0);
    });
});
