import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS, DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS, DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS } from '@/sync/domains/models/dynamicModelProbeCache';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';

const { capabilityRpc } = vi.hoisted(() => ({ capabilityRpc: vi.fn() }));

const preflight = await installNewSessionPreflightHarness((...args) => capabilityRpc(...args));
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');
const probeCache = await import('@/sync/domains/models/dynamicModelProbeCache');
beforeEach(async () => {
    await preflight.reset();
    probeCache.resetDynamicModelProbeCacheForTests();
});
afterEach(standardCleanup);
afterAll(() => preflight.dispose());

describe('model discovery stale-while-revalidate contract', () => {
    async function setup() {
        capabilityRpc.mockReset();
        cache.resetDynamicModelProbeCacheForTests();
        const key = (cwd: string) => buildDynamicModelProbeCacheKey({ machineId: 'swr-machine', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), providerConnectionId: null, serverId: preflight.serverId, cwd })!;
        const render = (enabled = true) => renderHook(
            (props: { enabled: boolean; cwd: string }) => useNewSessionPreflightModelsState({
                backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'swr-machine',
                capabilityServerId: preflight.serverId, cwd: props.cwd, enabled: props.enabled,
            }), { initialProps: { enabled, cwd: '/repo' } },
        );
        return { cache, key, render };
    }

    it('keeps the last observation and timestamp on failure without copying it to a new cwd cache identity', async () => {
        const { cache, key, render } = await setup();
        const observedAt = Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1;
        const value = { availableModels: [{ id: 'last-good', name: 'Last good' }], supportsFreeform: true };
        cache.writeDynamicModelProbeCacheSuccess(key('/repo'), value, observedAt);
        capabilityRpc.mockResolvedValue({ ok: false as const, error: { message: 'Daemon capability unavailable' } });
        const hook = await render();
        expect(hook.getCurrent().preflightModels).toBe(value);
        expect(hook.getCurrent().probe.refreshedAt).toBe(observedAt);
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().probe.failed).toBe(true);
        });
        expect(cache.readDynamicModelProbeCache(key('/repo'))?.updatedAt).toBe(observedAt);
        await hook.rerender({ enabled: true, cwd: '/other' });
        expect(hook.getCurrent().preflightModels).toBeNull();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(cache.readDynamicModelProbeCache(key('/other'))?.kind).toBe('error');
        });
        await hook.unmount();
    });

    it('performs no requests or retry scheduling while disabled and revalidates stale data when enabled', async () => {
        vi.useFakeTimers();
        try {
            const { cache, key, render } = await setup();
            const value = { availableModels: [{ id: 'cached', name: 'Cached' }], supportsFreeform: true };
            cache.writeDynamicModelProbeCacheSuccess(key('/repo'), value, Date.now() - DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS - 1);
            capabilityRpc.mockResolvedValue({ ok: false as const, error: { message: 'Daemon capability unavailable' } });
            const hook = await render(false);
            expect(hook.getCurrent().preflightModels).toBe(value);
            expect(capabilityRpc).not.toHaveBeenCalled();
            await act(async () => { await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS * 2); });
            expect(capabilityRpc).not.toHaveBeenCalled();
            await hook.rerender({ enabled: true, cwd: '/repo' });
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(capabilityRpc).toHaveBeenCalledTimes(1);
                expect(hook.getCurrent().probe.failed).toBe(true);
            });
            await hook.rerender({ enabled: false, cwd: '/repo' });
            await act(async () => { await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS * 2); });
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            await hook.unmount();
        } finally { vi.useRealTimers(); }
    });

    it('accepts nonpersistent provider success without an error retry and retains equal row identity', async () => {
        vi.useFakeTimers();
        try {
            const { render } = await setup();
            const observedAt = Date.now() - 1000;
            capabilityRpc.mockResolvedValue({ ok: true, result: {
                availableModels: [{ id: 'provider-model', name: 'Provider model' }], supportsFreeform: true,
                source: 'dynamic', cacheable: false, observedAt,
            } });
            const hook = await render();
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(hook.getCurrent().probe.refreshedAt).toBe(observedAt);
            });
            const models = hook.getCurrent().preflightModels;
            expect(hook.getCurrent().probe.refreshedAt).toBe(observedAt);
            expect(hook.getCurrent().probe.failed).toBe(false);
            await act(async () => { await vi.advanceTimersByTimeAsync(DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS + 1); });
            expect(capabilityRpc).toHaveBeenCalledTimes(1);
            await act(async () => { hook.getCurrent().probe.onRefresh?.(); });
            expect(hook.getCurrent().preflightModels).toBe(models);
            await waitForHomeGovernance(async () => {
                await flushHookEffects();
                expect(capabilityRpc).toHaveBeenCalledTimes(2);
                expect(hook.getCurrent().probe.phase).toBe('idle');
            });
            expect(capabilityRpc.mock.calls[1][1].params.bypassCache).toBe(true);
            expect(hook.getCurrent().preflightModels).toBe(models);
            await hook.unmount();
        } finally { vi.useRealTimers(); }
    });
});

it('accepts an authoritative empty discovery as a Default-only catalog', () => {
    expect(parsePreflightModelListFromProbeModelsResult({ availableModels: [], supportsFreeform: false })).toEqual({ availableModels: [], supportsFreeform: false });
});

