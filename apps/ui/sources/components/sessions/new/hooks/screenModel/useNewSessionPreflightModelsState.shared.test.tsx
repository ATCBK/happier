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
