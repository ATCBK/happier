import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    resetDynamicSessionModeProbeCacheForTests,
    DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
} from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

const capabilityRpc = vi.fn();

function assertRefreshFn(value: unknown): asserts value is () => void {
    if (typeof value !== 'function') {
        throw new Error('Expected probe.onRefresh to be a function');
    }
}

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const probeCache = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicSessionModeProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('useNewSessionPreflightSessionModesState (refresh)', () => {
    it('forces a refresh probe without clearing existing options', async () => {

        capabilityRpc.mockReset();
        resetDynamicSessionModeProbeCacheForTests();
        preflight.setCapabilityResponder(capabilityRpc);

        let call = 0;
        capabilityRpc.mockImplementation(async () => {
            call++;
            return {
                    ok: true as const,
                    result: { availableModes: [{ id: `mode${call}`, name: `Mode ${call}` }] },
                };
        });

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId,
            cwd: '/repo',
        }));

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);
        });

        const onRefresh = hook.getCurrent().probe?.onRefresh;
        assertRefreshFn(onRefresh);

        await act(async () => {
            onRefresh();
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode2')).toBe(true);
        });

        await hook.unmount();
    });

    it('retries after an error cooldown elapses so transient capability errors do not permanently hide session modes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);

        capabilityRpc.mockReset();
        resetDynamicSessionModeProbeCacheForTests();
        preflight.setCapabilityResponder(capabilityRpc);

        capabilityRpc
            .mockImplementationOnce(async () => ({ ok: false as const, error: { message: 'Daemon capability unavailable' } }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: { availableModes: [{ id: 'mode1', name: 'Mode 1' }] },
                }));

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId,
            cwd: '/repo',
        }));

        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(false);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().probe.phase).toBe('idle');
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS + 1);
        });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);
        });

        await hook.unmount();
        vi.useRealTimers();
    });

    it('retries after an unavailable cooldown elapses so temporarily gated session modes can recover', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);

        capabilityRpc.mockReset();
        resetDynamicSessionModeProbeCacheForTests();
        preflight.setCapabilityResponder(capabilityRpc);

        capabilityRpc
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: { source: 'unavailable', availableModes: [] },
                }))
            .mockImplementationOnce(async () => ({
                    ok: true as const,
                    result: { availableModes: [{ id: 'mode1', name: 'Mode 1' }] },
                }));

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId,
            cwd: '/repo-unavailable',
        }));

        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(false);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().preflightModes).toEqual({
                availableModes: [],
                unavailable: true,
            });
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS + 1);
        });

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(capabilityRpc).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);
        });

        await hook.unmount();
        vi.useRealTimers();
    });

    it('does not enter a render loop when probeContext identity churns but cached values are stable by content', async () => {

        capabilityRpc.mockReset();
        resetDynamicSessionModeProbeCacheForTests();

        preflight.setCapabilityResponder(capabilityRpc);
        capabilityRpc.mockRejectedValue(new Error('unexpected probe call'));

        const cachedValue = {
            availableModes: [{ id: 'mode1', name: 'Mode 1' }],
        };
        const { buildDynamicSessionModeProbeCacheKey } = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCacheKey');
        const { resolveBackendTargetKeyV2 } = await import('@/agents/backendCatalog/backendTargetKeyV2');
        const key = buildDynamicSessionModeProbeCacheKey({ machineId: 'machine-1', serverId: preflight.serverId,
            targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), cwd: '/repo',
            extraKeySuffixParts: ['appServer'] });
        if (!key) throw new Error('Expected an exact preflight mode cache identity');
        probeCache.writeDynamicSessionModeProbeCacheSuccess(key, cachedValue);

        const { useNewSessionPreflightSessionModesState } = await import('./useNewSessionPreflightSessionModesState');
        const hook = await renderHook(() => useNewSessionPreflightSessionModesState({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedMachineId: 'machine-1',
            capabilityServerId: preflight.serverId,
            cwd: '/repo',
            probeContext: {
                cacheKeySuffixParts: ['appServer'],
                capabilityParams: { profileId: 'profile-a' },
            },
        } as any));

        expect(hook.getCurrent().modeOptions.some((o) => o.id === 'mode1')).toBe(true);
        expect(capabilityRpc).not.toHaveBeenCalled();
        const options = hook.getCurrent().modeOptions;

        await hook.rerender();
        expect(hook.getCurrent().modeOptions).toBe(options);
        expect(capabilityRpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
