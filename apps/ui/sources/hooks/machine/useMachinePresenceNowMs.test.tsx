import { afterEach, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { useSessionListRuntimeNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useMachinePresenceNowMs } from './useMachinePresenceNowMs';

afterEach(async () => {
    await standardCleanup();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

it('keeps a fresh presence instant stable across unrelated renders and wakes at the real grace expiry', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS', '1000');
    vi.setSystemTime(10_000);
    // A mounted neighboring surface must not make a newly mounted presence read stale.
    const neighbor = await renderHook(() => useSessionListRuntimeNowMs());
    vi.setSystemTime(10_200);
    const first = [{ active: true, activeAt: 10_000 }];
    const presence = await renderHook((machines: typeof first) => useMachinePresenceNowMs(machines), {
        initialProps: first,
    });
    expect(presence.getCurrent()).toBe(10_200);
    vi.setSystemTime(10_400);
    await presence.rerender(first);
    expect(presence.getCurrent()).toBe(10_200);

    const renewed = [{ active: true, activeAt: 10_400 }];
    await presence.rerender(renewed);
    expect(presence.getCurrent()).toBe(10_400);
    expect(isMachineOnline(renewed[0], presence.getCurrent())).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await flushHookEffects({ advanceTimersMs: 1_001, cycles: 1, turns: 2 });
    expect(isMachineOnline(renewed[0], presence.getCurrent())).toBe(false);
    await presence.unmount();
    await neighbor.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
