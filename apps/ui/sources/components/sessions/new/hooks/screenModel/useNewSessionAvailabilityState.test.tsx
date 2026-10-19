import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { act } from 'react-test-renderer';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

installNewSessionScreenModelCommonModuleMocks({ storage: async (importOriginal) => importOriginal() });

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { getMachineCapabilitiesCacheState } = await import('@/hooks/server/useMachineCapabilitiesCache');
const { resolveDaemonCapabilitiesCacheKeySalt } = await import('@/hooks/server/useDaemonScopedMachineCapabilitiesCache');
const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');

beforeEach(() => {
    network.resetRequests();
    network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
});
afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});
afterAll(() => network.dispose());

describe('machine launch readiness', () => {
    it('keeps current cached Agent resume facts without probing a passive embedded composer', async () => {
        const { PluginProjectionV2Schema } = await import('@happier-dev/protocol');
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
        const home = await network.addHome('https://passive-availability.example.test', 'passive-owner');
        const machine = createMachineFixture({ id: 'passive-availability', active: true, activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: home.id });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, agentsById: {
            'acme.resume/resume': { id: 'acme.resume/resume', identity: { pluginId: 'acme.resume', localId: 'resume' },
                capabilities: { surfaces: ['terminal'], sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } },
        } });
        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1, projection });
        const warmer = await renderHook(() => useDaemonMergedProjectionInputs({ machineId: machine.id, serverId: home.id }));
        await vi.waitFor(() => expect(warmer.getCurrent().phase).toBe('ready'));
        expect(warmer.getCurrent().inputs?.pluginProjectionV2?.agentsById['acme.resume/resume']?.capabilities?.sessions?.open).toContain('resume');
        const requestsBefore = network.requests.length;
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: machine.id, selectedMachine: machine, capabilityServerId: home.id,
            machineProbesEnabled: false, runtimeCarrierAgentId: 'acme.resume/resume',
            externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [machine], allProfiles: [],
        }));
        expect(hook.getCurrent().showResumePicker).toBe(true);
        expect(network.requests.slice(requestsBefore)).toEqual([]);
        await hook.unmount();
        await warmer.unmount();
    });

    it('checks the new registry namespace after hydration without rechecking unrelated publications', async () => {
        vi.useFakeTimers();
        network.respond('capabilities.detect', { protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: Date.now(), data: { available: true } },
        } });
        const machine = createMachineFixture({ id: 'launch-hydration', activeAt: Date.now(), daemonStateVersion: 0 });
        const home = await network.addHome('https://launch-hydration.example.test', 'launch-account');
        const serverId = home.id;
        storage.getState().applyMachines([machine], false, { sourceServerId: serverId });
        const hook = await renderHook((selectedMachine: typeof machine) => useNewSessionAvailabilityState({
            selectedMachineId: machine.id, selectedMachine, capabilityServerId: serverId,
            externalSessionsFeatureEnabled: false, settings: settingsDefaults, resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [selectedMachine], allProfiles: [],
        }), { initialProps: machine, flushOptions: { advanceTimersMs: 0 } });
        try {
            expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready');
            const hydrated = { ...machine, daemonStateVersion: 1103, daemonState: { status: 'running', pid: 12, contributionRegistryProjectionRevision: 0 } };
            await act(async () => storage.getState().applyMachines([hydrated], false, { sourceServerId: serverId }));
            await hook.rerender(hydrated);
            await vi.waitFor(() => expect(getMachineCapabilitiesCacheState(machine.id, serverId, resolveDaemonCapabilitiesCacheKeySalt(hydrated, serverId))?.status).toBe('loaded'));
            expect(hook.getCurrent().selectedMachineCapabilities.status).toBe('loaded');
            expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready');
            const probesAfterHydration = network.requests.length;
            const published = { ...hydrated, daemonStateVersion: 1104, daemonState: { ...hydrated.daemonState, localServices: { v: 1, state: 'ready', runningCount: 1 } } };
            await act(async () => storage.getState().applyMachines([published], false, { sourceServerId: serverId }));
            await hook.rerender(published);
            expect(hook.getCurrent().selectedMachineSpawnReadiness.status).toBe('ready');
            expect(network.requests.length).toBe(probesAfterHydration);
            await hook.rerender({ ...published, activeAt: Date.now() + 1, seq: machine.seq + 1 });
            expect(network.requests.length).toBe(probesAfterHydration);
        } finally {
            await hook.unmount();
        }
    });
});

describe('effective terminal host availability', () => {
    it.each(['herdr', 'zellij', 'tmux', 'none'] as const)('warns about tmux only when the effective host is tmux, not %s', async (host) => {
        const hook = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: null, selectedMachine: null, capabilityServerId: 'server-a',
            externalSessionsFeatureEnabled: false,
            settings: { ...settingsDefaults, sessionTerminalHost: host, sessionUseTmux: host === 'tmux' },
            staticAgentId: 'codex', resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {}, resolvedBackendEntries: [], selectedBackendEntry: null,
            setBackendTarget: vi.fn(), machines: [], allProfiles: [],
        }));
        expect(hook.getCurrent().tmuxRequested).toBe(host === 'tmux');
        await hook.unmount();
    });
});
