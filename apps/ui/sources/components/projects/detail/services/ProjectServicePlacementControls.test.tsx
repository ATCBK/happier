import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { buildLocalServiceRows } from '@/sync/domains/local/services/serviceRow';

import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import type { ServerScopedMachinePoolSelection } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { getServerProfileById, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const remote = vi.hoisted(() => vi.fn());
// The addressed daemons are the network boundary; placement, relocation and Action policy stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: remote }),
);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    View: 'View',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => key === 'projectServices.moveConfirm' ? `${key}:${JSON.stringify(params)}` : key,
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// The browser portal/window measurement boundary renders inline; destination/menu logic stays real.
vi.mock('@/components/ui/popover', async importOriginal =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

let fixture:
  | Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>
  | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  remote.mockReset();
  storage.getState().clearProjectAccountRowsScope();
  actionOperationStore.reset();
  vi.restoreAllMocks();
});

const base: WorkspaceExecutionSettingsV1 = {
  enabled: false,
  unavailable: 'ask',
  allowAdHoc: false,
  scriptOverrides: {},
  services: {},
};

async function setup(options: Readonly<{
  running: boolean;
  /** The Machine that owns the service binding observation fails to answer. */
  actualFails?: boolean;
  saved?: WorkspaceExecutionSettingsV1['services'][string];
  portable?: boolean;
  modelOnly?: boolean;
  /** Wait for an enabled Runs on (custody known); off for states that keep it disabled. */
  waitEnabled?: boolean;
  sharedObservation?: boolean;
  waiveMoveApproval?: boolean;
  serviceRuntime?: ReturnType<typeof createFrontDoorRuntimeActionExecutor>;
  onStart?: (request: Readonly<{ machineId: string; params: unknown }>) => void;
}>) {
  const writes: WorkspaceExecutionSettingsV1[] = [];
  const poolReads: unknown[] = [];
  let placementReadsFail = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  fixture = await createPlainArtifactHomeFixture(
    'https://service-placement-ui.test',
    {
      handleRequest: async (path, init) => {
        if (options.serviceRuntime && path === '/v2/account/settings') return json({
          content: { t: 'plain', v: storage.getState().settings }, version: storage.getState().settingsVersion ?? 0,
        });
        // Binding observation now reads the real Machine inventory to qualify child
        // topology. These are ordinary Machines; a missing HTTP fixture is not
        // evidence that their native service custody is unavailable.
        if (path === '/v1/machines?includeRevoked=true') return json(['devbox', 'hz-build-1', 'pool-worker'].map(id => ({
          id, revokedAt: null, replacedByMachineId: null,
        })));
        if (path === '/v1/projects/execution/config/read' && placementReadsFail) return json({ error: 'unavailable' }, 503);
        if (path === '/v1/projects/execution/config/read')
          return json(options.saved
            ? { status: 'present', revision: 1, content: { t: 'plain', v: { ...base, services: { server: options.saved } } } }
            : { status: 'absent' });
        if (path === '/v1/projects/execution/config/mutate') {
          const request = JSON.parse(String(init?.body)) as {
            content: { v: WorkspaceExecutionSettingsV1 } | null;
          };
          if (request.content) writes.push(request.content.v);
          return json({
            status: 'updated',
            revision: writes.length,
            cursor: writes.length,
          });
        }
        if (path === '/v1/machines/pools/list') return json({ pools: [] });
        if (path === '/v1/machines/pools/get') {
          const { poolId } = JSON.parse(String(init?.body)) as { poolId: string };
          poolReads.push({ poolId });
          return json({
            pool: { id: poolId, name: 'Build pool', description: null, revision: 1,
              createdAt: 1, updatedAt: 1, members: [{ machineId: 'pool-worker', priorityTier: 0,
                enabled: true, state: 'connected' }] },
            availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
          });
        }
        return null;
      },
      serverFeatures: (() => {
        const features = buildServerFeaturesResponse();
        return { ...features, features: { ...features.features,
          machines: { ...features.features.machines, pools: { enabled: true } } } };
      })(),
    },
  );
  if (options.serviceRuntime) {
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_service_creation');
    await fixture.hydrateAccountSettings();
  }
  const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  await getServerFeaturesSnapshot({ serverId: fixture.home.id, force: true });
  // Ask first is the Action default; these cases waive it in the Account's canonical settings.
  const { settingsParse } = await import('@/sync/domains/settings/settings');
  const settingsScope = storage.getState().settingsScope;
  if (!settingsScope) throw new Error('expected_settings_scope');
  storage.getState().applySettingsForScope(settingsScope, settingsParse({ ...storage.getState().settings,
    ...(options.serviceRuntime ? { managedMachineCreationEnabled: true } : {}),
    actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'projects.service.placement.set': ['ui'], ...(options.waiveMoveApproval !== false ? { 'projects.service.relocate': ['ui'] } : {}), 'machines.pools.resolve': ['ui'], 'action.operations.cancel': ['ui'] } },
  }), (storage.getState().settingsVersion ?? 0) + 1);
  const serverId = fixture.home.id;
  const scope = { serverId, accountId: 'artifact-account' };
  const source = {
    id: 'checkout',
    serverId,
    machineId: 'devbox',
    rootPath: '/src/happier',
    createdAtMs: 1,
  };
  storage.getState().activateProjectAccountRowsScope(scope);
  storage
    .getState()
    .applyProjectAccountRowsForScope(scope, {
      scope,
      status: 'ready',
      coverage: 'complete',
      workspaceRefs: [source],
      relationships: [],
      organizations: [],
      revisionsByPhysicalKey: {},
    });
  const target = {
    id: 'server-target',
    source: 'managed_service',
    sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
    machineId: source.machineId,
    workspaceId: source.id,
    workspace: {
      serverId,
      workspaceId: source.id,
      machineId: source.machineId,
      rootPath: source.rootPath,
    },
    cwd: source.rootPath,
    declaration: {
      workspaceRefId: source.id,
      selection: { kind: 'manifest', name: 'server' },
    },
    serviceState: 'running',
    readiness: 'ready',
    title: 'server',
    state: 'available',
    confidence: 'high',
    actions: ['manage'],
  };
  const workerStatusMethod = getActionSpec('projects.worker.status').bindings?.rpcMethod;
  if (!workerStatusMethod) throw new Error('missing_worker_status_method');
  remote.mockImplementation(async ({ machineId, method, payload: params }) => {
    if (method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START) {
      options.onStart?.({ machineId, params });
      return { protocolVersion: 1, machineId, targetId: params.targetId, status: 'denied', reasonCode: 'native_boundary_observed',
        snapshot: { v: 1, machineId, updatedAt: 1, targets: [] } };
    }
    if (method === 'actionOperation.cancel.v1') return { kind: 'requested' };
    if (method === workerStatusMethod) return {
      eligible: machineId === 'pool-worker',
      candidate: machineId === 'pool-worker' ? { serverId, machineId } : null,
      load: { kind: 'unknown' },
      explanation: machineId === 'pool-worker' ? 'load_unknown' : 'not_accepting',
    };
    if (options.actualFails) throw new Error('owner_unavailable');
    return {
    protocolVersion: 1,
    snapshot: {
      v: 1,
      machineId,
      updatedAt: 1,
      targets:
        options.running && machineId === source.machineId ? [target] : [],
    },
  };
  });
  let setLifecycle: (key: string) => void = () => {};
  const placementOwner =
    await import('./ProjectServicePlacementControls');
  const { ProjectServicePlacementControls, useProjectServicePlacement } = placementOwner;
  // This consumer contract deliberately stays below the disabled Move producer.
  // Its real caller attaches the accepted Action receipt, not a fabricated runtime outcome.
  const observationOwner = options.sharedObservation
    ? await import('./projectServicePlacementObservation') : null;
  let attach: ((operation: ActionOperationSnapshotV1) => void) | undefined;
  let setDetail: ((open: boolean) => void) | undefined;
  let setSourceRef: ((refId: string) => void) | undefined;
  let setDeclarationBasis: ((basis: string) => void) | undefined;
  let setControlVisible: ((visible: boolean) => void) | undefined;
  function ObservationProbe() {
    const observation = observationOwner!.useProjectServicePlacementObservation('server');
    attach = operation => observation.attach({ operationId: operation.operationId,
      destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } } });
    return null;
  }
  let model: ReturnType<typeof useProjectServicePlacement> | null = null;
  function ModelProbe() {
    model = useProjectServicePlacement({ serverId, refId: source.id, machineId: source.machineId }, 'server');
    return null;
  }
  const { WorkerDestinationPicker } =
    await import('@/components/projects/workers/WorkerDestinationPicker');
  const { useLocalServiceLauncherStartAction } = await import('@/components/sessions/localServices/launcherStartAction');
  let start: (() => Promise<unknown>) | undefined;
  function StartProbe() {
    const launch = useLocalServiceLauncherStartAction({ runtimeActionExecute: options.serviceRuntime, serverId });
    const launchTarget: LocalServiceLaunchTarget = { id: 'declared-server', machineId: source.machineId,
      source: 'managed_service', title: 'server', actions: ['start'], state: 'available', confidence: 'high',
      workspace: { serverId, workspaceId: source.id, machineId: source.machineId, rootPath: source.rootPath },
      declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'server' } } };
    start = async () => launch?.(launchTarget);
    return null;
  }
  function Host() {
    const [lifecycleKey, setKey] = React.useState('initial');
    const [detail, setDetailOpen] = React.useState(false);
    const [refId, setRefId] = React.useState(source.id);
    const [declarationBasis, setBasis] = React.useState('manifest-v1');
    const [controlVisible, setVisible] = React.useState(true);
    setDeclarationBasis = setBasis;
    setControlVisible = setVisible;
    setDetail = setDetailOpen;
    setSourceRef = setRefId;
    setLifecycle = setKey;
    if (options.modelOnly) return <ModelProbe />;
    const control = (
      <ProjectServicePlacementControls
        key={options.sharedObservation ? 'list' : detail ? 'detail' : 'list'}
        testID="placement"
        serviceName="server"
        source={{ serverId, refId, machineId: source.machineId }}
        declaration={{ portable: options.portable !== false, currentnessKey: declarationBasis }}
        lifecycleKey={lifecycleKey}
      />
    );
    if (!observationOwner) return control;
    const Provider = observationOwner.ProjectServicePlacementObservationProvider;
    return <Provider source={{ serverId, refId, machineId: source.machineId }} runtimeActionExecute={options.serviceRuntime}><ObservationProbe /><StartProbe />{controlVisible ? control : null}
      {detail ? <ProjectServicePlacementControls testID="detail.placement" serviceName="server"
        source={{ serverId, refId, machineId: source.machineId }} declaration={{ portable: options.portable !== false, currentnessKey: declarationBasis }} lifecycleKey={lifecycleKey} /> : null}
    </Provider>;
  }
  const screen = await renderScreen(<Host />);
  if (options.modelOnly) await vi.waitFor(() => expect(model?.state.kind).toBe('ready'));
  else if (options.waitEnabled !== false) await vi.waitFor(() =>
    expect(screen.findAllByTestId('placement.runsOn')[0]?.props.disabled, JSON.stringify([fixture?.requests, screen.getTextContent(), remote.mock.calls])).toBe(false),
  );
  const choose = async (machineId: string) => {
    await act(async () => {
      screen.tree
        .findByType(WorkerDestinationPicker)
        .props.onChoose({
          kind: 'workers',
          destination: { kind: 'machine', machineId },
        });
    });
  };
  const choosePool = async (poolId: string) => {
    const selection: ServerScopedMachinePoolSelection = {
      serverId,
      accountId: 'artifact-account',
      pool: { pool: { id: poolId, name: 'Build pool', description: null, revision: 1,
        createdAt: 1, updatedAt: 1, members: [] },
        availability: { state: 'known', connectedCount: 1, enabledCount: 1 } },
    };
    await act(async () => {
      await screen.tree.findByType(WorkerDestinationPicker).props.onChoose({
        kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' },
      }, selection);
    });
  };
  const runsOn = () => screen.findAllByTestId('placement.runsOn')[0]!;
  return { screen, writes, poolReads, choose, choosePool, runsOn, model: () => model!, serverId,
    start: () => start!(),
    setDeclarationBasis: (basis: string) => setDeclarationBasis!(basis), setControlVisible: (visible: boolean) => setControlVisible!(visible),
    failPlacementReads: () => { placementReadsFail = true; },
    setLifecycle: (key: string) => setLifecycle(key), setDetail: (open: boolean) => setDetail!(open),
    setSourceRef: (refId: string) => setSourceRef!(refId), attach: (operation: ActionOperationSnapshotV1) => attach!(operation) };
}

describe('Service Runs on through the placement and relocation Actions', () => {
  it.each(['ready', 'preset', 'dual', 'cancel', 'back', 'source-changed', 'declaration-changed', 'unknown', 'inventory', 'move', 'move-cancel'] as const)('keeps New Machine selection effect-free and continues the exact Service once (%s)', async mode => {
    const acquisitions: unknown[] = [];
    const acquisitionRequests: (string | undefined)[] = [];
    const starts: unknown[] = [];
    const moves: unknown[] = [];
    const enrollment = createDeferred<void>();
    const controller = { machineId: 'controller', installationId: 'installation' };
    const launch = { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Service worker', choices: {} };
    const retention = { kind: 'until-delete' } as const;
    const moving = mode === 'move' || mode === 'move-cancel';
    const heldEnrollment = ['dual', 'cancel', 'back', 'source-changed', 'declaration-changed', 'move', 'move-cancel'].includes(mode);
    let machine: ManagedMachineV1;
    let inventoryReads = 0;
    const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
    const frontDoor = createFrontDoorRuntimeActionExecutor(createActionExecutor(createActionExecutorBoundaryFixture({
      isActionApprovalRequired: () => false,
      managedMachineAction: async request => {
        if (request.actionId === 'machines.managed.acquire') {
          acquisitions.push(request.input);
          if (mode === 'unknown' && acquisitions.length === 1) throw new Error('allocation_ack_lost');
          return { managedId: 'paid-service', operation: { operationId: 'install-service' } };
        }
        if (request.actionId === 'machines.managed.get') {
          if (heldEnrollment) await enrollment.promise;
          return machine;
        }
        if (request.actionId === 'machines.managed.list') { inventoryReads += 1; return { machines: [machine] }; }
        throw new Error('unexpected_managed_transport');
      },
      actionOperationAction: async () => ({ kind: 'found', operation: { version: 1, operationId: 'install-service', revision: 2,
        actionId: 'machines.managed.acquire', state: 'succeeded', scope: { accountId: 'artifact-account', machineId: 'controller' },
        title: 'Install', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported' } }),
      // Native Machine execution is the transport boundary. Source lookup and relocation dispatch stay real.
      runtimeActionExecute: createDefaultRuntimeActionExecutor({}, undefined, async request => {
        moves.push(request);
        return { status: 'refused', reasonCode: 'native_boundary_observed' };
      }),
    })));
    const execute: typeof frontDoor = async request => {
      if (request.actionId === 'machines.managed.acquire') acquisitionRequests.push(request.context?.actionRequestId ?? undefined);
      return frontDoor(request);
    };
    const { screen, writes, serverId, start, setSourceRef, setDetail, setDeclarationBasis, setControlVisible } = await setup({ running: moving, sharedObservation: true, serviceRuntime: execute,
      onStart: request => starts.push(request) });
    const homeId = getServerProfileById(serverId)!.serverIdentityId!;
    machine = { id: 'paid-service', homeId, custodianAccountId: 'artifact-account', launch, controller,
      allocation: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1, retention,
      wakeOnAcceptedMessage: false, ...(mode === 'inventory' ? {} : { enrolledMachineId: 'new-service-worker' }) };
    const draft = createManagedMachineSelectionDraft({ selection: mode === 'preset' ? { kind: 'preset', homeId, id: 'service-preset', revision: 1 }
      : { kind: 'one-off', homeId, launch, controller, retention, wakeOnAcceptedMessage: false },
      receipt: { launch, controller, optionStatus: 'current', prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
        retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: false } });
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    if (mode === 'ready') {
      await screen.pressByTestIdAsync('placement.runsOn');
      const { ManagedMachineSelectionOffers } = await import('@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers');
      expect(screen.tree.findAllByType(ManagedMachineSelectionOffers)).toHaveLength(1);
      await vi.waitFor(() => {
        expect(screen.findAllByTestId('placement.picker:section:managed-machines').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId(`placement.picker-managed-machine:${homeId}:one-off`).length).toBeGreaterThan(0);
      });
      const { Modal } = await import('@/modal');
      vi.mocked(Modal.show).mockClear();
      await screen.pressByTestIdAsync(`placement.picker-managed-machine:${homeId}:one-off`);
      expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
        props: expect.objectContaining({ serverId, accountId: 'artifact-account', preset: null }),
      }));
      await act(async () => screen.tree.findByType(WorkerDestinationPicker).props.onRequestClose());
      expect(acquisitions).toEqual([]);
    }
    if (mode === 'dual') await act(async () => setDetail(true));
    await act(async () => { screen.tree.findAllByType(WorkerDestinationPicker).at(-1)!.props.onChooseManagedMachine(draft); });
    if (mode === 'dual') expect(screen.tree.findAllByType(WorkerDestinationPicker).map(node => node.props.selectedManagedMachine)).toEqual([draft, draft]);
    expect(acquisitions).toEqual([]);
    expect(starts).toEqual([]);
    expect(writes).toEqual([]);
    let completion: Promise<unknown> | undefined;
    if (moving) {
      await screen.pressByTestIdAsync('placement.move.confirm');
    } else act(() => { completion = start(); });
    await vi.waitFor(() => expect(acquisitions).toHaveLength(1));
    if (heldEnrollment || mode === 'inventory') {
      expect(starts).toEqual([]);
      expect(moves).toEqual([]);
      if (mode === 'cancel' || mode === 'move-cancel') {
        await vi.waitFor(() => expect(screen.findByTestId('placement.creation.cancel')).toBeTruthy());
        await screen.pressByTestIdAsync('placement.creation.cancel');
      }
      if (mode === 'source-changed') await act(async () => { setSourceRef('another-checkout'); });
      if (mode === 'declaration-changed') await act(async () => { setDeclarationBasis('manifest-v2'); });
      if (mode === 'back') await act(async () => { setControlVisible(false); });
      if (mode === 'dual') await act(async () => { await start(); });
      if (mode === 'inventory') {
        await vi.waitFor(async () => { await flushHookEffects(); expect(inventoryReads).toBeGreaterThan(0); });
        machine = { ...machine, enrolledMachineId: 'new-service-worker' };
        act(() => publishHomeAccountChange(serverId));
      }
      enrollment.resolve();
      if (mode === 'inventory') await vi.waitFor(async () => { await flushHookEffects(); expect(starts).toHaveLength(1); });
    }
    if (mode === 'unknown') {
      await act(async () => { await completion; });
      await act(async () => { completion = start(); });
      expect(acquisitionRequests).toHaveLength(2);
      expect(acquisitionRequests[1]).toBe(acquisitionRequests[0]);
    }
    await act(async () => { await completion; });
    if (['cancel', 'back', 'source-changed', 'declaration-changed', 'move-cancel'].includes(mode)) {
      expect(starts).toEqual([]);
      expect(moves).toEqual([]);
    } else if (mode === 'move') {
      await vi.waitFor(() => expect(moves).toHaveLength(1));
      expect(moves[0]).toMatchObject({ context: { externalActionTarget: { kind: 'machine', machineId: 'devbox' } },
        input: { destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'new-service-worker' } } } });
      expect(starts).toEqual([]);
    } else {
      expect(starts, JSON.stringify(screen.findAllByTestId('placement.creation').flatMap(node =>
        Array.isArray(node.props.details) ? node.props.details.filter((value: unknown) => typeof value === 'string') : []))).toHaveLength(1);
      expect(starts[0]).toMatchObject({ machineId: 'new-service-worker', params: { machineId: 'new-service-worker',
        workspace: { machineId: 'devbox', workspaceId: 'checkout' },
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'new-service-worker' } } } });
    }
    expect(acquisitions).toHaveLength(mode === 'unknown' ? 2 : 1);
    await screen.unmount();
  });
  it.each(['exact', 'automatic'] as const)('honours a UI Move waiver for an %s destination without a second confirmation', async destination => {
    const { screen, writes, choose, choosePool } = await setup({ running: true, waiveMoveApproval: true });
    if (destination === 'exact') await choose('hz-build-1');
    else await choosePool('00000000-0000-4000-8000-000000000032');
    // The real Action path currently reports the unavailable relocation producer.
    // Reaching that result proves the waiver admitted the request, rather than
    // leaving it stranded in a consumer-owned confirmation state.
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.refused')).toBeTruthy());
    expect(screen.findByTestId('placement.move.confirm')).toBeNull();
    expect(writes).toEqual([]);
  });
  // FX12: a literally confirmed Stop publishes `stopped` before cancellable revalidation; `copying` follows only when copying begins.
  it.each([['failed', 'copying'], ['cancelled', 'copying'], ['cancelled', 'stopped']] as const)('retains the accepted Move through list/detail remounts, confirmed-Stop settlement (%s after %s) and Source retirement', async (terminalState, settledPhase) => {
    // Count live subscriptions, not calls: remounting two presentation bodies must
    // retain one accepted-operation observer and one Cancel continuation owner.
    const subscribe = actionOperationStore.subscribe;
    let observers = 0;
    vi.spyOn(actionOperationStore, 'subscribe').mockImplementation(listener => {
      observers += 1;
      const unsubscribe = subscribe(listener);
      return () => { observers -= 1; unsubscribe(); };
    });
    const { screen, serverId, attach, setDetail, setSourceRef, writes } = await setup({ running: true, sharedObservation: true });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'retained-service-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', workspace: {
        serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'copying', label: 'Copying current files' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
      setDetail(true);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.findByTestId('detail.placement.move.inspect')).toBeTruthy();
    expect(observers).toBe(1);
    expect(screen.getTextContent()).toContain('Copying current files');
    await screen.pressByTestIdAsync('placement.move.stop');
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('projectServices.cancelPending'));
    expect(actionOperationStore.getSnapshot().operationsByKey.values().next().value?.snapshot.state).toBe('running');
    await act(async () => { setDetail(false); });
    expect(screen.findByTestId('detail.placement.move.inspect')).toBeNull();
    expect(screen.findByTestId('placement.move.inspect')).toBeTruthy();
    expect(screen.getTextContent()).toContain('projectServices.cancelPending');
    expect(observers).toBe(1);
    // The native feed corroborates the operation's already-confirmed stop.
    remote.mockImplementation(async ({ machineId }) => ({ protocolVersion: 1,
      snapshot: { v: 1, machineId, updatedAt: 3, targets: [] } }));
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [{
        ...operation, revision: 2, state: terminalState, settledAt: 3,
        progress: { kind: 'phase', phase: settledPhase, label: settledPhase === 'stopped' ? 'Stopped on devbox' : 'Copying current files' },
        ...(terminalState === 'failed' ? { error: { errorCode: 'service_preparation_failed', error: 'Preparation failed' } } : {}),
      }] });
      setDetail(true);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.findByTestId('detail.placement.move.inspect')).toBeTruthy();
    expect(screen.findByTestId('placement.move.refused')).toBeNull();
    expect(screen.findByTestId('placement.move.stop')).toBeNull();
    await vi.waitFor(() => expect(screen.getTextContent()).toContain(
      terminalState === 'failed' ? 'projectServices.moveFailedStopped' : 'projectServices.moveCancelledStopped'));
    expect(screen.findAllByTestId('placement.runsOn')[0]?.props.disabled).toBe(false);
    expect(screen.findAllByTestId('placement.picker')[0]?.props.selected).toEqual({ kind: 'primary' });
    expect(writes).toEqual([]);
    await act(async () => { setSourceRef('another-checkout'); });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeNull());
    expect(observers).toBe(0);
  });

  it('shows canonical uncertain-start observation and retains Inspect without inferring stopped recovery', async () => {
    const { screen, serverId, attach, runsOn, choose, writes, failPlacementReads, setLifecycle } = await setup({ running: false, sharedObservation: true });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'uncertain-service-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'running', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', workspace: {
        serverId, machineId: 'hz-build-1', workspaceId: 'worker-checkout', rootPath: '/worker/happier' },
      declaration: { workspaceRefId: 'worker-checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase: 'starting', label: 'Starting service' },
      observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projectServices.moveUnknown');
    expect(screen.getTextContent()).toContain('Starting service');
    expect(runsOn().props.disabled).toBe(true);
    expect(runsOn().props.subtitle).not.toBe('projectServices.moveFailedStopped');
    await choose('hz-build-1');
    expect(writes).toEqual([]);
    failPlacementReads();
    await act(async () => { setLifecycle('settings-unavailable'); });
    await vi.waitFor(() => expect(screen.findByTestId('placement.unavailable')).toBeTruthy());
    expect(screen.findByTestId('placement.move.inspect')).toBeTruthy();
  });
  it.each(['stopping', 'starting'])('retains a failed %s operation without treating terminal state and absence as safe recovery', async phase => {
    const { screen, serverId, attach, runsOn, choose, writes } = await setup({ running: false, sharedObservation: true });
    const operation: ActionOperationSnapshotV1 = { version: 1, operationId: 'unproven-service-move', revision: 1,
      actionId: 'projects.service.relocate', state: 'failed', scope: { accountId: 'artifact-account', machineId: 'devbox' },
      title: 'Move server', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported',
      domainRef: { kind: 'projectService', purpose: 'relocation', workspace: {
        serverId, machineId: 'devbox', workspaceId: 'checkout', rootPath: '/src/happier' },
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } } },
      progress: { kind: 'phase', phase, label: 'Move phase' }, error: { errorCode: 'move_failed', error: 'Move failed' } };
    await act(async () => {
      publishActionOperationObservation({ serverId, machineId: 'devbox', observation: 'available', snapshots: [operation] });
      attach(operation);
    });
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.inspect')).toBeTruthy());
    expect(screen.getTextContent()).toContain('projectServices.moveUnknown');
    expect(screen.findByTestId('placement.move.refused')).toBeNull();
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(writes).toEqual([]);
  });
  it('passes the current declaration portability and memory to the row placement owner', async () => {
    const { createProjectServicePlacementRenderer } = await import('./ProjectServicePlacementControls');
    const facts = { portable: false, memoryDemand: { bytes: 2147483648, basis: { kind: 'declared' as const } } };
    const source = { serverId: 'home', machineId: 'devbox', refId: 'checkout' };
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [{
      id: 'declared', source: 'managed_service', machineId: 'devbox', title: 'server',
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'server' } },
      confidence: 'high', state: 'unavailable', unavailableReason: 'launch_unavailable', actions: [],
    }], sessionId: null, scope: 'workspace' });
    const render = createProjectServicePlacementRenderer(source, { server: facts });
    expect((render?.(row!) as React.ReactElement<{ declaration: typeof facts }>).props.declaration).toEqual(facts);
  });
  it('refreshes placement when a new native occurrence replaces one with the same row id and running state', async () => {
    const { createProjectServicePlacementRenderer } = await import('./ProjectServicePlacementControls');
    const target = { id: 'service', source: 'managed_service' as const, machineId: 'source',
      sourceClass: { kind: 'managed_service' as const, managedServiceId: 'first' }, serviceState: 'running' as const,
      declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest' as const, name: 'web' } },
      confidence: 'high' as const, state: 'available' as const, title: 'web', actions: [] };
    const [row] = buildLocalServiceRows({ inventoryRows: [], launchTargets: [target], sessionId: null, scope: 'workspace' });
    const render = createProjectServicePlacementRenderer({ serverId: 'home', refId: 'checkout', machineId: 'source' }, { web: { portable: true } });
    const first = render?.(row!) as React.ReactElement<{ lifecycleKey: string }>;
    const next = render?.({ ...row!, target: { ...target, sourceClass: { kind: 'managed_service', managedServiceId: 'replacement' } } }) as React.ReactElement<{ lifecycleKey: string }>;
    expect(next.props.lifecycleKey).not.toBe(first.props.lifecycleKey);
  });
  it.each([false, true])('the placement model itself refuses a stopped save for uncertain or live custody (live=%s)', async running => {
    const { model, writes } = await setup({ running, actualFails: !running, modelOnly: true });
    expect(model()).toMatchObject({
      actual: { status: running ? 'present' : 'unavailable' },
      desiredPlacement: { runsOn: { kind: 'primary' } },
      canSaveNextStart: false,
      canMove: running,
    });
    await act(async () => { await model().save({ runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' }); });
    expect(writes).toEqual([]);
  });
  it('displays the actual Machine rather than the differing desired placement for a live service', async () => {
    const { model } = await setup({ running: true, modelOnly: true,
      saved: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } }, unavailable: 'fail' } });
    expect(model()).toMatchObject({ displayChoice: { kind: 'primary' },
      desiredPlacement: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'hz-build-1' } } } });
  });

  it('does not treat an unobservable binding as stopped: no save, and a way to check again', async () => {
    const { screen, writes, choose, runsOn } = await setup({ running: false, actualFails: true, waitEnabled: false });
    await vi.waitFor(() => expect(screen.findByTestId('placement.custody')).toBeTruthy());
    expect(runsOn().props.disabled).toBe(true);
    await choose('hz-build-1');
    expect(writes).toEqual([]);
  });

  it('offers no workers for a primary-only service', async () => {
    const { screen, runsOn } = await setup({ running: false, portable: false, waitEnabled: false });
    await vi.waitFor(() => expect(String(runsOn().props.subtitle)).toBe('projectServices.primaryOnly'));
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    expect(screen.tree.findAllByType(WorkerDestinationPicker)).toHaveLength(0);
    // A primary-only service has nothing to choose: no control that can never succeed, no dimmed row.
    expect(screen.tree.findAll(node => String(node.props.testID ?? '').startsWith('placement.fallback'))).toHaveLength(0);
    expect(runsOn().props.disabled).toBeFalsy();
    expect(runsOn().props.onPress).toBeUndefined();
  });

  it('does not claim primary-only custody when the actual binding is unavailable', async () => {
    const { screen, runsOn } = await setup({ running: false, actualFails: true, portable: false, waitEnabled: false });
    await vi.waitFor(() => expect(screen.findByTestId('placement.custody')).toBeTruthy());
    expect(runsOn().props.detail).toBe('projectServices.actualUnavailable');
    expect(runsOn().props.subtitle).toBe('projectServices.actualUnavailable');
  });

  it('re-reads the binding when the Services feed observes a lifecycle change', async () => {
    const { setLifecycle } = await setup({ running: false });
    const reads = () => remote.mock.calls.length;
    const before = reads();
    await act(async () => { setLifecycle('running:devbox'); });
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('saves a stopped service’s next start without opening a Move', async () => {
    const { screen, writes, choose } = await setup({ running: false });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(writes, JSON.stringify([fixture?.requests, screen.findAllByTestId('placement.notice')[0]?.props.title])).toHaveLength(1));
    expect(writes[0]?.services.server).toEqual({
      runsOn: {
        kind: 'workers',
        destination: { kind: 'machine', machineId: 'hz-build-1' },
      },
      unavailable: 'fail',
    });
    expect(screen.findByTestId('placement.move')).toBeNull();
  });

  it('saves a stopped service’s same-pool change from Ask to Automatic', async () => {
    const poolId = '00000000-0000-4000-8000-000000000032';
    const { screen, writes } = await setup({ running: false, saved: {
      runsOn: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'ask' } },
      unavailable: 'fail',
    } });
    const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
    await act(async () => {
      screen.tree.findByType(WorkerDestinationPicker).props.onChoose({
        kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' },
      });
    });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.services.server).toEqual({
      runsOn: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' } },
      unavailable: 'fail',
    });
    expect(screen.findByTestId('placement.move')).toBeNull();
  });

  it('honours the target Home Move waiver when another Account settings projection is focused', async () => {
    const { screen, choose } = await setup({ running: true });
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    storage.setState({ settingsScope: { serverId: 'foreign-home', accountId: 'foreign-account' },
      settings: settingsParse({ actionsSettingsV1: { v: 1, actions: {} } }) });
    await choose('hz-build-1');
    await vi.waitFor(() => expect(screen.findByTestId('placement.move.refused')).toBeTruthy());
    expect(screen.findByTestId('placement.move.confirm')).toBeNull();
  });

  it('asks by default before moving a running service and cancellation leaves placement unsaved', async () => {
    const { screen, writes, choose } = await setup({ running: true, waiveMoveApproval: false });
    await choose('hz-build-1');
    await vi.waitFor(() =>
      expect(screen.findByTestId('placement.move')).toBeTruthy(),
    );
    await screen.pressByTestIdAsync('placement.move.cancel');
    expect(screen.findByTestId('placement.move')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('resolves an Automatic pool to one exact Machine before the default Move review', async () => {
    const poolId = '00000000-0000-4000-8000-000000000032';
    const { screen, writes, poolReads, choosePool } = await setup({ running: true, waiveMoveApproval: false });
    await choosePool(poolId);
    await vi.waitFor(() => expect(screen.findByTestId('placement.move')).toBeTruthy());
    expect(poolReads).toEqual([{ poolId }]);
    expect(screen.getTextContent()).toContain('pool-worker');
    await screen.pressByTestIdAsync('placement.move.cancel');
    expect(JSON.stringify(remote.mock.calls)).toContain('pool-worker');
    expect(remote.mock.calls).toContainEqual([expect.objectContaining({
      machineId: 'pool-worker', payload: expect.objectContaining({
        purpose: 'service-start', workspace: expect.objectContaining({ refId: 'checkout' }),
      }),
    })]);
    expect(writes).toEqual([]);
  });
});
