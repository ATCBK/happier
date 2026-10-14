import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { LocalServiceLaunchTargetV1Schema, type LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';
import { createLocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import { resetLocalServiceLauncherStoreForTests } from '@/sync/domains/local/services/launch/sharedStore';
import { publishLocalServiceInventorySnapshot, resetLocalServiceInventoryStoreForTests } from '@/sync/domains/local/services/inventory/sharedStore';
import { useLocalServiceLiveFeeds } from './useLocalServiceLiveFeeds';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';

const remote = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { alert } }).module;
});
// Only the daemon transport is replaced; accepted topology, observation and both stores stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: remote }));
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; resetLocalServiceLauncherStoreForTests(); resetLocalServiceInventoryStoreForTests();
  storage.getState().clearProjectAccountRowsScope(); remote.mockReset(); alert.mockReset(); });

describe('Project Services source feed plus actual native binding', () => {
  it.each(['absent', 'failed', 'retired'] as const)('settles the first fresh binding without another Machine census or inventory watch (%s)', async outcome => {
    let censusReads = 0;
    home = await createPlainArtifactHomeFixture('https://project-services-first-binding.test', { handleRequest: async path => {
      if (path !== '/v1/machines?includeRevoked=true') return null;
      if (++censusReads > 1) return new Promise<Response>(() => {});
      return new Response(JSON.stringify([{ id: 'source', revokedAt: null, replacedByMachineId: null }]));
    } });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    const declaration = LocalServiceLaunchTargetV1Schema.parse({ id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] });
    let releaseBinding!: () => void;
    const bindingRead = new Promise<void>(resolve => { releaseBinding = resolve; });
    let bindingRequested = false;
    const snapshotClient = async (input: { machineId: string; projection?: 'managed_bindings' }) => {
      if (input.projection) { bindingRequested = true; await bindingRead; }
      if (input.projection && outcome === 'failed') return { ok: false as const, reason: 'request_failed' as const };
      return { ok: true as const, snapshot: { v: 1 as const, machineId: input.machineId, updatedAt: 1,
        targets: input.projection ? [] : [declaration] } };
    };
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace',
      inventoryState: createLocalServiceInventoryState(), launcherSnapshotClient: snapshotClient }));
    try {
      await vi.waitFor(() => expect(bindingRequested).toBe(true));
      const before = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
        sessionId: null, scope: 'workspace' });
      expect(before[0]?.primaryAction).toBeNull();
      expect.soft(before[0]?.status).toBe('loading');
      expect.soft(before[0]?.reasonCode).not.toBe('project_service_binding_unavailable');
      expect.soft(hook.getCurrent().launcherState!.refreshStatus).toBe('refreshing');
      await act(async () => {
        if (outcome === 'retired') storage.getState().clearProjectAccountRowsScope();
        releaseBinding();
      });
      await vi.waitFor(() => {
        const rows = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
          sessionId: null, scope: 'workspace' });
        expect(rows[0]).toMatchObject(outcome === 'absent'
          ? { status: 'stopped', primaryAction: { kind: 'start', target: declaration } }
          : { status: 'unavailable', primaryAction: null });
        if (outcome === 'failed') expect(hook.getCurrent().launcherState!.refreshStatus).toBe('idle');
      });
    } finally { releaseBinding(); await hook.unmount(); }
  });
  it('shows the typed daemon refusal through Refresh without exposing the transport message', async () => {
    home = await createPlainArtifactHomeFixture('https://project-services-refusal.test', { handleRequest: async path =>
      path === '/v2/account/settings' ? new Response(JSON.stringify({ content: { t: 'plain', v: {} }, version: 0 })) : null });
    await home.hydrateAccountSettings();
    let refuseRefresh = false;
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      if (refuseRefresh && method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
        throw new RpcError('private transport detail', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
      }
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 2,
        refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId: home!.home.id,
      scope: 'machine', launcherState: null }));
    try {
      await vi.waitFor(() => expect(hook.getCurrent().inventoryState.generatedAt).toBe(2));
      refuseRefresh = true;
      await act(async () => { await hook.getCurrent().refresh!(); });
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0]?.[1]).not.toContain(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
      expect(alert.mock.calls[0]?.[1]).not.toContain('private transport detail');
      const buttons = alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
      buttons.find(button => button.onPress)?.onPress?.();
      expect(alert.mock.calls[1]?.[1]).toContain(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    } finally {
      await hook.unmount();
    }
  });
  it.each([false, true])('explicit Refresh obeys Action enablement (%s), while automatic observations remain available', async enabled => {
    home = await createPlainArtifactHomeFixture('https://project-services-refresh.test', { handleRequest: async path =>
      path === '/v2/account/settings' ? new Response(JSON.stringify({ content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, actions: { 'localServices.inventory.refresh': { enabled } } },
      } }, version: 0 })) : null });
    await home.hydrateAccountSettings();
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH ? 2 : 1,
        refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId: home!.home.id,
      scope: 'machine', launcherState: null }));
    await vi.waitFor(() => expect(hook.getCurrent().inventoryState.generatedAt).toBe(2));
    remote.mockClear();
    await act(async () => { await hook.getCurrent().refresh!(); });
    expect(remote.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH)).toBe(enabled);
    await hook.unmount();
  });
  it.each([false, true])('shows the worker occurrence and reobserves Stop (bind-child SOURCE=%s)', async bindChild => {
    let childProjection: unknown;
    let managedRow: unknown;
    home = await createPlainArtifactHomeFixture('https://project-services-feed.test', { handleRequest: async path => {
      if (path === '/v1/machines?includeRevoked=true') return new Response(JSON.stringify([{ id: 'source', installationId: 'child-installation',
        devcontainerChild: childProjection, revokedAt: null, replacedByMachineId: null },
        { id: 'worker', installationId: 'worker-installation', revokedAt: null, replacedByMachineId: null },
        { id: 'parent', installationId: 'parent-installation', revokedAt: null, replacedByMachineId: null }]));
      if (path === managedMachineActionEndpointPathV1('machines.managed.get')) return new Response(JSON.stringify(managedRow));
      return null;
    } });
    const serverId = home.home.id;
    const scope = { serverId, accountId: 'artifact-account' };
    const source = { id: 'source-ref', machineId: 'source', serverId, rootPath: '/source', createdAtMs: 1 };
    const worker = { id: 'worker-ref', machineId: 'worker', serverId, rootPath: '/copy', createdAtMs: 1 };
    const parent = { ...source, id: 'parent-ref', machineId: 'parent', rootPath: '/host-source' };
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: source.rootPath,
      storage: { kind: 'bind', hostPath: parent.rootPath, childPath: source.rootPath } };
    childProjection = bindChild ? { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer', parentMachineId: 'parent' }, observation } : undefined;
    managedRow = { id: 'managed-child', homeId: serverId, custodianAccountId: 'artifact-account',
      controller: { machineId: 'parent', installationId: 'parent-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: observation },
      allocation: 'bound', creationState: 'active', enrolledMachineId: 'source', desired: 'start', desiredWhen: 'now',
      intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const physicalSource = bindChild ? parent : source;
    const relationship: WorkspaceSyncRelationshipV1 = { v: 1, relationshipId: 'copy', controllerMachineId: physicalSource.machineId,
      alphaWorkspaceRefId: physicalSource.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: bindChild ? [source, parent, worker] : [source, worker], relationships: [relationship], organizations: [], revisionsByPhysicalKey: {} });
    const declaration: LocalServiceLaunchTargetV1 = { id: 'source-service', source: 'managed_service', machineId: source.machineId,
      workspaceId: source.id, workspace: { serverId, machineId: source.machineId, workspaceId: source.id, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } }, cwd: source.rootPath,
      title: 'web', confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [] };
    const actual: LocalServiceLaunchTargetV1 = { ...declaration, id: 'worker-service', machineId: worker.machineId,
      workspaceId: worker.id, workspace: { serverId, machineId: worker.machineId, workspaceId: worker.id, rootPath: worker.rootPath },
      declaration: { workspaceRefId: worker.id, selection: { kind: 'manifest', name: 'web' } }, cwd: worker.rootPath,
      sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' }, state: 'available',
      unavailableReason: undefined, serviceState: 'running', readiness: 'ready', actions: ['manage'] };
    let running = true;
    let finishRefresh!: () => void;
    const pendingRefresh = new Promise<void>(resolve => { finishRefresh = resolve; });
    let refreshing = false;
    const snapshotClient = async (input: { machineId: string; projection?: 'managed_bindings' }) => {
      if (input.projection && !running) { refreshing = true; await pendingRefresh; }
      return { ok: true as const,
      snapshot: { v: 1 as const, machineId: input.machineId, updatedAt: running ? 1 : 2,
        targets: input.projection === 'managed_bindings' ? input.machineId === 'worker' && running ? [actual] : [] : [declaration] } };
    };
    remote.mockImplementation(async ({ method, machineId }: { method: string; machineId: string }) => {
      if (method.endsWith('.watch')) return new Promise(() => {});
      return { protocolVersion: 1, snapshot: { v: 1, machineId, generatedAt: 1, refreshState: 'idle', entries: [], diagnostics: [] } };
    });
    const hook = await renderHook(() => useLocalServiceLiveFeeds({ machineId: 'source', serverId,
      workspaceRefId: source.id, workspaceRoot: source.rootPath, scope: 'workspace',
      inventoryState: createLocalServiceInventoryState(), launcherSnapshotClient: snapshotClient }));
    await vi.waitFor(() => expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual([actual]));
    running = false;
    await act(async () => { publishLocalServiceInventorySnapshot({ serverId, machineId: 'worker' }, {
      v: 1, machineId: 'worker', generatedAt: 2, refreshState: 'idle', entries: [], diagnostics: [] }); });
    await vi.waitFor(() => expect(refreshing).toBe(true));
    expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual([actual]);
    expect(buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      sessionId: null, scope: 'workspace' })[0]).toMatchObject({ status: 'running' });
    await act(async () => { finishRefresh(); });
    await vi.waitFor(() => expect([...hook.getCurrent().launcherState!.targetsById.values()]).toEqual([declaration]));
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [...hook.getCurrent().launcherState!.targetsById.values()],
      sessionId: null, scope: 'workspace' });
    expect(row).toMatchObject({ status: 'stopped', primaryAction: { kind: 'start', target: declaration } });
    expect(row!.target.actions).toEqual([]);
    await hook.unmount();
  });
});
