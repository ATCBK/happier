import { installNewSessionPreflightHarness } from '@/dev/testkit/harness/newSessionPreflightHarness';
import { standardCleanup } from '@/dev/testkit';
import { describe, expect, it, vi, afterAll, afterEach, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import * as cache from '@/sync/domains/models/dynamicModelProbeCache';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';

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

it('synchronizes exact-key consumers after refresh without probing unrelated subscribers', async () => {
    cache.resetDynamicModelProbeCacheForTests();
    capabilityRpc.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'shared-machine', targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
    cache.writeDynamicModelProbeCacheSuccess(key, { availableModels: [{ id: 'before', name: 'Before' }], supportsFreeform: false });
    capabilityRpc.mockResolvedValue({ ok: true, result: {
        availableModels: [{ id: 'after', name: 'After' }], supportsFreeform: false,
    } });
    const render = (cwd: string, enabled = true) => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'shared-machine',
        capabilityServerId: preflight.serverId, cwd, enabled,
    }));
    const screen = await render('/repo');
    const detail = await render('/repo');
    const other = await render('/other', false);
    expect(capabilityRpc).not.toHaveBeenCalled();
    const otherOptions = other.getCurrent().modelOptions;
    await act(async () => { detail.getCurrent().probe.onRefresh?.(); });
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(screen.getCurrent().preflightModels?.availableModels.map((model) => model.id)).toEqual(['after']);
    });
    expect(screen.getCurrent().preflightModels).toBe(detail.getCurrent().preflightModels);
    expect(other.getCurrent().modelOptions).toBe(otherOptions);
    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await detail.unmount();
    await other.unmount();
});

it('retains another model picker but releases an abandoned occurrence before remount', async () => {
    capabilityRpc.mockReset();
    capabilityRpc.mockImplementationOnce(() => new Promise<never>(() => {}));
    capabilityRpc.mockResolvedValue({ ok: true, result: {
        availableModels: [{ id: 'remounted', name: 'Remounted' }], supportsFreeform: false,
    } });
    const render = () => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'owned-machine',
        capabilityServerId: preflight.serverId, cwd: '/repo',
    }));
    const first = await render();
    const retained = await render();
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(1);
    });
    await first.unmount();
    const joined = await render();
    expect(capabilityRpc).toHaveBeenCalledTimes(1);
    expect(retained.getCurrent().probe.phase).toBe('loading');
    await retained.unmount();
    await joined.unmount();
    const remounted = await render();
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(capabilityRpc).toHaveBeenCalledTimes(2);
        expect(remounted.getCurrent().preflightModels?.availableModels.map(model => model.id)).toEqual(['remounted']);
        expect(remounted.getCurrent().probe.phase).toBe('idle');
    });
    await remounted.unmount();
});

it.each([false, true])('does not retry an unknown model outcome on the clock or remount (retained: %s)', async (retainGood) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    capabilityRpc.mockReset();
    const key = buildDynamicModelProbeCacheKey({ machineId: 'unknown-model-machine',
        targetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }),
        providerConnectionId: null, serverId: preflight.serverId, cwd: '/repo' })!;
    if (retainGood) cache.writeDynamicModelProbeCacheSuccess(key, {
        availableModels: [{ id: 'retained', name: 'Retained' }], supportsFreeform: false,
    }, 900_000);
    cache.writeDynamicModelProbeCacheError(key, 1_000_000, undefined, {
        reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown',
    });
    const render = () => renderHook(() => useNewSessionPreflightModelsState({
        backendTarget: { kind: 'backend', backendId: 'codex' }, selectedMachineId: 'unknown-model-machine',
        capabilityServerId: preflight.serverId, cwd: '/repo',
    }));
    const first = await render();
    expect(first.getCurrent().probe).toMatchObject({ phase: 'idle', reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' });
    await act(async () => { await vi.advanceTimersByTimeAsync(cache.DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS + 1); });
    await first.unmount();
    const remounted = await render();
    expect(remounted.getCurrent().probe.reason).toBe('outcomeUnknown');
    expect(capabilityRpc).not.toHaveBeenCalled();
    expect(remounted.getCurrent().preflightModels?.availableModels.map(model => model.id) ?? []).toEqual(retainGood ? ['retained'] : []);
    await remounted.unmount();
    vi.useRealTimers();
});
