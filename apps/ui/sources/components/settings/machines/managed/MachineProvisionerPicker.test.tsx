import { createRequire } from 'node:module';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Prepare the real owner graph after installing boundaries, outside per-operation test budgets.
await import('./useManagedControllerScope');
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => {
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

// The Add route owns page presentation; without it the grouped-menu header intentionally omits page actions.
function renderPicker(element: React.ReactElement) {
  return renderScreen(
    <ListPresentationProvider value="page">{element}</ListPresentationProvider>,
  );
}

describe('provisioner picker demand', () => {
  it('prefers this computer only while it is an installed online controller, without demanding local status', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { publishLocalDaemonStatus, readLocalDaemonSharedState } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
    const runner = getSystemTasksRunner();
    const previous = readLocalDaemonSharedState(runner).status;
    onTestFinished(() => publishLocalDaemonStatus(runner, previous));
    publishLocalDaemonStatus(runner, { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'z' });
    const online = (id: string) => createMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now() });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const local = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(local.getCurrent().controller?.machineId).toBe('z');
    await local.unmount();
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), createMachineFixture({ id: 'z', installationId: 'z-installation', active: false, activeAt: 0 })] } }));
    const remote = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(remote.getCurrent().controller?.machineId).toBe('a');
    await remote.unmount();
  });
  it('keeps a deterministic online controller across inventory order and presence changes, and retains explicit draft choice', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const online = (id: string) => createMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    const asleep = createMachineFixture({ id: 'ghost', installationId: 'ghost-installation', active: false, activeAt: 0 });
    const retired = createMachineFixture({ id: 'retired', installationId: 'retired-installation', activeAt: Date.now(), replacedByMachineId: 'a' });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [asleep, retired, online('z'), online('a')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const onSelect = vi.fn();
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe', onSelect }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('z'), asleep, online('a'), retired] } }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('z'), asleep,
      createMachineFixture({ id: 'a', installationId: 'a-installation', active: false, activeAt: 0 })] } }));
    // An automatic pick whose machine went offline yields to the online controller.
    expect(scope.getCurrent().controller?.machineId).toBe('z');
    const target = scope.getCurrent().selection?.pickerRows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    expect(target).toBeDefined();
    await act(async () => scope.getCurrent().selection?.selectTarget(target!));
    expect(onSelect).toHaveBeenCalledWith({ machineId: 'z', installationId: 'z-installation' });
    await scope.rerender();
    expect(scope.getCurrent().controller?.machineId).toBe('z');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'),
      createMachineFixture({ id: 'z', installationId: 'z-installation', activeAt: Date.now(), replacedByMachineId: 'a' })] } }));
    expect(scope.getCurrent().controller?.machineId).toBe('z');
    expect(scope.getCurrent().selection?.state.kind).toBe('replaced');
    expect(scope.getCurrent().selection?.resolveExecutionTarget()).toBeNull();
    await scope.unmount();
  });
  it('starts the next Add visit on the controller the person last picked', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const online = (id: string) => createMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    // The remembered pick is a device-local Account setting, written through the sync runtime like every other target memory.
    const syncRuntime = await import('@/sync/syncEngine');
    (createRequire(import.meta.url)('../../../../sync/sync.ts') as typeof import('@/sync/sync')).registerSyncRuntime(syncRuntime);
    const previousSettings = storage.getState().settings;
    onTestFinished(() => storage.setState({ settings: previousSettings, settingsScope: null }));
    await act(async () => storage.setState({ settingsScope: { serverId, accountId: 'owner' } }));
    const first = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(first.getCurrent().controller?.machineId).toBe('a');
    const target = first.getCurrent().selection?.pickerRows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    await act(async () => first.getCurrent().selection?.selectTarget(target!));
    await first.unmount();
    const second = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(second.getCurrent().controller?.machineId).toBe('z');
    await second.unmount();
  });
  it('moves an automatic controller choice after a failed request proves it unreachable', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    onTestFinished(clearMachineRequestReachabilityForTest);
    const online = (id: string) => createMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(scope.getCurrent().controller?.machineId).toBe('a');

    // Request observations use the Home's canonical scope, not its device-local route profile id.
    await act(async () => recordMachineRequestFailed({ serverId: 'srv_build', accountId: 'owner', machineId: 'a' }));

    expect(scope.getCurrent().controller?.machineId).toBe('z');
    await scope.unmount();
  });
  it('lets the person switch controller while the Home\u2019s machine list is being re-read after a failure', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const online = (id: string) => createMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), metadata: null });
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [online('a'), online('z')] }, machineListStatusByServerId: { srv_build: 'error' } }));
    const onSelect = vi.fn();
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe', onSelect,
      preferred: { machineId: 'a', installationId: 'a-installation' } }));
    const rows = scope.getCurrent().selection?.pickerRows ?? [];
    const target = rows.find(row => row.candidate.target.machineId === 'z')?.candidate.target;
    expect(target).toBeDefined();
    await act(async () => scope.getCurrent().selection?.selectTarget(target!));
    expect(onSelect).toHaveBeenCalledWith({ machineId: 'z', installationId: 'z-installation' });
    await scope.unmount();
  });
  it('leaves automatic scope unselected when only offline or retired controllers exist', async () => {
    const serverId = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    await act(async () => storage.setState({ machineListByServerId: { srv_build: [
      createMachineFixture({ id: 'ghost', installationId: 'ghost-installation', active: false, activeAt: 0 }),
      createMachineFixture({ id: 'retired', installationId: 'retired-installation', activeAt: Date.now(), replacedByMachineId: 'next' }),
    ] }, machineListStatusByServerId: { srv_build: 'idle' } }));
    const scope = await renderHook(() => useManagedControllerScope({ serverId, testIDPrefix: 'scope-probe' }));
    expect(scope.getCurrent().controller).toBeUndefined();
    await scope.unmount();
  });
  it('identifies New preset before a Home is selected, without demanding a provisioner catalog', async () => {
    const homeId = await harness.addHome({ name: 'Build', serverUrl: 'https://preset-build.example', serverIdentityId: 'srv_preset_build', accountId: 'owner', currentAccount: true });
    const { NewMachinePresetRoute } = await import('@/app/(app)/settings/machines/presets/new');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { t } = await import('@/text');
    const screen = await renderScreen(<DestinationInstanceHost tabId="preset-new" ref={{ kind: 'settings', params: { pageId: 'machines/presets/new' } }}
      pathname="/settings/machines/presets/new" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
      <NewMachinePresetRoute />
    </DestinationInstanceHost>);
    expect(screen.root.findAll(node => node.props.accessibilityRole === 'header')
      .some(node => node.props.children === t('machinePresets.newPreset'))).toBe(true);
    expect(screen.findByTestId(`managed-picker.home:${homeId}`)).not.toBeNull();
  });
  it('names each Home through the Home label owner, never by its address', async () => {
    const homeId = await harness.addHome({ name: 'preset-home.example:3011', serverUrl: 'https://preset-home.example:3011', serverIdentityId: 'srv_preset_home', accountId: 'owner', currentAccount: true });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { resolveHomeDisplayLabel } = await import('@/components/settings/server/homeDisplayName');
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const screen = await renderPicker(<MachineProvisionerPicker serverId="" presetOnly />);
    const row = screen.root.findAll(node => node.props.testID === `managed-picker.home:${homeId}` && node.props.title !== undefined)[0];
    expect(row?.props.title).toBe(resolveHomeDisplayLabel(getServerProfileById(homeId), homeId));
    expect(String(row?.props.title)).not.toContain('preset-home.example');
  });
  it.each([
    { location: 'cloud', credentialFailure: false },
    { location: 'unknown', credentialFailure: false },
    { location: 'cloud', credentialFailure: true },
    { location: 'cloud', credentialFailure: false, checkFailure: true },
  ] as const)(
    'retains completed provider status without acquiring ($location, credential failure=$credentialFailure)',
    async ({ location, credentialFailure, ...rest }) => {
      const checkFailure = 'checkFailure' in rest;
      const serverId = await harness.addHome({
        name: 'Build',
        serverUrl: 'https://build.example',
        serverIdentityId: 'srv_build',
        accountId: 'owner',
        currentAccount: true,
      });
      const { storage } = await import('@/sync/domains/state/storage');
      storage.setState({
        machineListByServerId: {
          [serverId]: [
            createMachineFixture({
              id: 'controller',
              installationId: 'installation',
              activeAt: Date.now(),
              kind: 'persistent',
            }),
          ],
        },
        machineListStatusByServerId: { [serverId]: 'idle' },
      });
      const contribution = { pluginId: 'custom.compute', localId: 'native' };
      const provisioner = {
        contribution,
        occurrenceId: 'occurrence',
        ...(credentialFailure ? { credentialPurposes: [{ purpose: { consumer: contribution, purpose: 'compute' }, options: [] }] } : {}),
        descriptor: {
          id: 'native',
          title: 'Custom compute',
          icon: 'server',
          resourceKind: 'native-compute-vm',
          schemaVersion: 1,
          kindTitle: { key: 'native.kind', fallback: 'VM' },
          description: {
            key: 'native.description',
            fallback: 'A custom native guest.',
          },
          launchSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          resourceSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          platforms: ['linux'],
          prerequisites: [],
          billing: { location, stoppedBilling: 'billed' },
          retention: { supportedIntents: ['delete'] },
          actions: {
            check: 'check',
            options: 'options',
            acquire: 'acquire',
            bootstrap: 'bootstrap',
            inspect: 'inspect',
            destroy: 'destroy',
          },
        },
        credentialPurposes: [{ purpose: { consumer: contribution, purpose: 'cloud-account' }, options: [] }],
      };
      const { MachineProvisionersListResultV1Schema } =
        await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
      MachineProvisionersListResultV1Schema.parse({
        controller: { machineId: 'controller', installationId: 'installation' },
        provisioners: [provisioner],
      });
      for (const [actionId, result] of [
        ['machines.provisioners.list', { controller: { machineId: 'controller', installationId: 'installation' }, provisioners: [provisioner] }],
        [
          'machines.provisioners.check',
          {
            available: false,
            code: 'license_required',
            status: { key: 'native.license', fallback: 'License required' },
          },
        ],
      ] as const) {
        harness.answer(serverId, `/v1/actions/${actionId}`, {
          select: (value) => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return {
              body: {
                v: 1,
                actionId,
                requestId: request.requestId,
                execution: credentialFailure && actionId === 'machines.provisioners.check'
                  ? { ok: false, errorCode: 'credential_unavailable', error: 'credential_unavailable' }
                  : checkFailure && actionId === 'machines.provisioners.check'
                    ? { ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' }
                    : { ok: true, result },
              },
            };
          },
        });
      }
      const onSelectProvisioner = vi.fn();
      const { MachineProvisionerPicker } =
        await import('./MachineProvisionerPicker');
      const { t } = await import('@/text');
      const { buildQualifiedPluginContributionKey } =
        await import('@happier-dev/protocol/plugins/contribution-identity');
      const screen = await renderPicker(
        <MachineProvisionerPicker
          serverId={serverId}
          onSelectProvisioner={onSelectProvisioner}
        />,
      );
      const row = `managed-picker.provisioners.cloud.${buildQualifiedPluginContributionKey(contribution)}`;
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId(`${row}.action`) ??
            screen.findByTestId(row) ??
            screen.findByTestId('managed-picker.unavailable'),
        ).not.toBeNull(),
      );
      if (checkFailure) {
        // One honest state: the line says the read failed, and the card claims nothing and cannot start.
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull());
        const unreadable = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(unreadable[0].status.label).toBe('');
        expect(unreadable[0].action.disabled).toBe(true);
        await screen.unmount();
        return;
      }
      await waitForHomeGovernance(() => {
        const cards = screen.tree
          .findAll((node) => Array.isArray(node.props.cards))
          .flatMap((node) => node.props.cards);
        if (credentialFailure && screen.findByTestId('managed-picker.unavailable')) return;
        expect(cards).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'VM',
              description: 'A custom native guest.',
              status: expect.objectContaining({
                label:
                  credentialFailure ? t('managedMachines.add.status.noAccount') : location === 'unknown'
                    ? `License required · ${t('managedMachines.add.status.billingUnknown')}`
                    : 'License required',
              }),
            }),
          ]),
        );
      });
      if (credentialFailure) {
        const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards);
        expect(cards[0].status.label).toBe(t('managedMachines.add.status.noAccount'));
        expect(cards[0].action.label).toBe(t('managedMachines.add.action.connect'));
      }
      expect(screen.findByTestId('managed-picker.unavailable')?.props.diagnosticCode).toBeUndefined();
      await act(async () =>
        screen.pressByTestId(
          screen.findByTestId(`${row}.action`) ? `${row}.action` : row,
        ),
      );
      expect(onSelectProvisioner).toHaveBeenCalledWith({
        serverId,
        provisioner: buildQualifiedPluginContributionKey(contribution),
        controller: { machineId: 'controller', installationId: 'installation' },
        ...(credentialFailure ? { connectPurpose: 'cloud-account' } : {}),
      });
      expect(
        harness.requests.some((request) =>
          request.path.includes('machines.managed.acquire'),
        ),
      ).toBe(false);
      await screen.unmount();
    },
  );
  /** One Home whose catalog answers with two provisioners; `hold` decides which later reads stay pending. */
  async function arrangeCatalog(hold: Readonly<{
    list?: (read: number, machineId: string) => boolean;
    check?: (read: number, localId: string) => boolean;
    /** Declared `[localId, title, kindTitle]` per provisioner; defaults to Alpha and Beta VMs. */
    declared?: readonly (readonly [string, string, string])[];
  }>) {
    const serverId = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: { [serverId]: ['controller', 'other'].map(id =>
        createMachineFixture({ id, installationId: `${id}-installation`, activeAt: Date.now(), kind: 'persistent' })) },
      machineListStatusByServerId: { [serverId]: 'idle' },
    });
    const descriptor = (localId: string, title: string, kind = 'VM') => ({
      contribution: { pluginId: 'custom.compute', localId }, occurrenceId: `occurrence-${localId}`, credentialPurposes: [],
      descriptor: {
        id: localId, title, icon: 'server', resourceKind: 'native-compute-vm', schemaVersion: 1,
        kindTitle: { key: `${localId}.kind`, fallback: kind }, description: { key: `${localId}.description`, fallback: `${title} guest.` },
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
        platforms: ['linux'], prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
        retention: { supportedIntents: ['delete'] },
        actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
      },
    });
    const provisioners = (hold.declared ?? [['alpha', 'Alpha', 'VM'], ['beta', 'Beta', 'VM']] as const)
      .map(([localId, title, kind]) => descriptor(localId, title, kind));
    const reads = { list: 0, check: new Map<string, number>() };
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reply = (actionId: string, requestId: string | undefined, execution: unknown) => ({ body: { v: 1, actionId, requestId, execution } });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: async (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        const controller = (request.input as { controller: { machineId: string; installationId: string } }).controller;
        reads.list += 1;
        if (hold.list?.(reads.list, controller.machineId)) await gate;
        return reply('machines.provisioners.list', request.requestId, { ok: true, result: { controller, provisioners } });
      },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', {
      select: async (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        const localId = (request.input as { contribution: { localId: string } }).contribution.localId;
        const read = (reads.check.get(localId) ?? 0) + 1;
        reads.check.set(localId, read);
        if (hold.check?.(read, localId)) await gate;
        return reply('machines.provisioners.check', request.requestId, localId === 'alpha'
          ? { ok: true, result: { available: false, code: 'license_required', status: { key: 'alpha.license', fallback: 'License required' } } }
          : { ok: false, errorCode: 'controller_unavailable', error: 'controller_unavailable' });
      },
    });
    return { serverId, reads, release, provisioners };
  }

  it('tells two provisioners of one product apart by their declared kind and says a pending check in a word', async () => {
    const { serverId, release } = await arrangeCatalog({
      declared: [['alpha', 'Cua', 'sandbox'], ['beta', 'Cua', 'space']],
      check: () => true,
    });
    const { t } = await import('@/text');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    const cards = () => [...new Map(screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { id: string; title: string; kind?: string; status: { label: string } }[])
      .map(card => [card.id, card])).values()];
    try {
      await waitForHomeGovernance(() => {
        // The composed title reads as one phrase; the standalone kind starts with a capital, as every label does.
        expect(cards().map(card => [card.title, card.kind])).toEqual([['Cua sandbox', 'Sandbox'], ['Cua space', 'Space']]);
      });
      // The catalog's own line owns "Checking available provisioners"; a card still waiting says only that it is checking.
      expect(cards().map(card => card.status.label)).toEqual([t('managedMachines.add.status.checking'), t('managedMachines.add.status.checking')]);
    } finally {
      release();
    }
    await screen.unmount();
  });

  it('keeps the answered checks on screen while the catalog is re-read', async () => {
    const { serverId, reads, release } = await arrangeCatalog({ check: (read) => read > 1 });
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    // Nested layout nodes repeat the same card objects; one entry per card.
    const cards = () => [...new Map(screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string; status: { label: string } }[]).map(card => [card.title, card])).values()];
    try {
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull();
        expect(cards().find(card => card.title === 'Alpha')?.status.label).toBe('License required');
      });
      await act(async () => screen.pressByTestId('managed-picker.unavailable-action'));
      await waitForHomeGovernance(() => expect(reads.check.get('alpha')).toBe(2));
      // The re-check is still pending: both cards keep what the last answer said.
      expect(cards().map(card => card.title)).toEqual(['Alpha', 'Beta']);
      expect(cards().find(card => card.title === 'Alpha')?.status.label).toBe('License required');
    } finally {
      release();
    }
    await screen.unmount();
  });
  it('shows each check as it answers, so one slow provisioner leaves the others readable', async () => {
    const { serverId, release } = await arrangeCatalog({ check: (_read, localId) => localId === 'beta' });
    const { t } = await import('@/text');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={serverId} onSelectProvisioner={vi.fn()} />);
    const cards = () => [...new Map(screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string; status: { label: string } }[]).map(card => [card.title, card])).values()];
    try {
      await waitForHomeGovernance(() => expect(cards().find(card => card.title === 'Alpha')?.status.label).toBe('License required'));
      // Beta's read is still pending: it says so itself and nothing else is blamed.
      expect(cards().find(card => card.title === 'Beta')?.status.label).toBe(t('managedMachines.add.status.checking'));
      expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
    } finally {
      release();
    }
    await screen.unmount();
  });
  it('keeps retained checks display-only when the replacement catalog fails, and enables Choose after recovery', async () => {
    const { serverId, provisioners } = await arrangeCatalog({});
    const onSelect = vi.fn();
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const preferred = { machineId: 'controller', installationId: 'controller-installation' };
    function FixedPicker() {
      const scope = useManagedControllerScope({ serverId, preferred, testIDPrefix: 'fixed-controller' });
      return <MachineProvisionerPicker serverId={serverId} scope={scope} onSelectProvisioner={onSelect} />;
    }
    harness.answer(serverId, '/v1/actions/machines.provisioners.check', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.check', requestId: request.requestId, execution: { ok: true,
        result: { available: false, code: 'license_required', status: { key: 'alpha.license', fallback: 'License required' } } } }) };
    } });
    const screen = await renderPicker(<FixedPicker />);
    const cards = () => screen.tree.findAll(node => Array.isArray(node.props.cards))
      .flatMap(node => node.props.cards as { title: string; status: { label: string }; action: { disabled?: boolean; onPress(): void } }[]);
    await vi.waitFor(async () => { await act(async () => {}); expect(cards().find(card => card.title === 'Alpha')?.status.label, 'initial check').toBe('License required'); });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: false, errorCode: 'unavailable', error: 'unavailable' } }) };
    } });
    // A refreshed credential for the same Account retires the binding; an unrelated Home publication does not.
    await act(async () => { await harness.switchAccount(serverId, 'owner', { currentAccount: true }); });
    await vi.waitFor(async () => { await act(async () => {}); expect(cards().find(card => card.title === 'Alpha')?.action.disabled, 'failed catalog').toBe(true); });
    expect(screen.findByTestId('managed-picker.unavailable')).not.toBeNull();
    const retained = cards().find(card => card.title === 'Alpha');
    expect(retained?.status.label).toBe('License required');
    expect(retained?.action.disabled).toBe(true);
    await act(async () => retained?.action.onPress());
    expect(onSelect).not.toHaveBeenCalled();
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
      const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
      const controller = request.input && typeof request.input === 'object' && 'controller' in request.input ? request.input.controller : undefined;
      if (!controller) throw new Error('Expected the requested controller');
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
        execution: { ok: true, result: { controller, provisioners } } }) };
    } });
    await act(async () => screen.pressByTestId('managed-picker.unavailable-action'));
    await vi.waitFor(async () => { await act(async () => {}); expect(cards().find(card => card.title === 'Alpha')?.action.disabled, 'recovered catalog').not.toBe(true); });
    await act(async () => cards().find(card => card.title === 'Alpha')?.action.onPress());
    expect(onSelect).toHaveBeenCalledOnce();
    await screen.unmount();
  });
  it('keeps the last catalog across a refreshed credential binding while the replacement reads', async () => {
    const { serverId, release } = await arrangeCatalog({ list: (read) => read > 1 });
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const hook = await renderHook(() => useManagedProvisioners(serverId, undefined, controller));
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners).toHaveLength(2));
      const firstBinding = hook.getCurrent().binding;
      // A refreshed credential retires the binding and binds the same Account again.
      await harness.switchAccount(serverId, 'owner', { currentAccount: true });
      await waitForHomeGovernance(() => expect(hook.getCurrent().binding).not.toBe(firstBinding));
      expect(hook.getCurrent().loading).toBe(true);
      expect(hook.getCurrent().provisioners).toHaveLength(2);
    } finally {
      release();
    }
  });
  it('keeps the last catalog while another controller is being read', async () => {
    const { serverId, release } = await arrangeCatalog({ list: (_read, machineId) => machineId === 'other' });
    const { useManagedProvisioners } = await import('./useManagedProvisioners');
    const first = { machineId: 'controller', installationId: 'controller-installation' };
    const hook = await renderHook(({ controller }) => useManagedProvisioners(serverId, undefined, controller), { initialProps: { controller: first } });
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().provisioners).toHaveLength(2));
      await hook.rerender({ controller: { machineId: 'other', installationId: 'other-installation' } });
      expect(hook.getCurrent().loading).toBe(true);
      expect(hook.getCurrent().provisioners).toHaveLength(2);
    } finally {
      release();
    }
  });
  it('asks for an explicit Home, then reads the preselected controller catalog without allocation', async () => {
    const first = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    await harness.addHome({
      name: 'Other',
      serverUrl: 'https://other.example',
      serverIdentityId: 'srv_other',
      accountId: 'other',
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [first]: [
          createMachineFixture({
            id: 'build-controller',
            installationId: 'build-installation',
            activeAt: Date.now(),
            kind: 'persistent',
          }),
        ],
      },
      machineListStatusByServerId: { [first]: 'idle' },
    });
    harness.answer(first, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.list',
            requestId: request.requestId,
            execution: { ok: true, result: { provisioners: [] } },
          },
        };
      },
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const screen = await renderPicker(
      <MachineProvisionerPicker serverId="" presetOnly />,
    );
    expect(
      harness.requestsFor('/v1/actions/machines.provisioners.list'),
    ).toHaveLength(0);
    expect(screen.findByTestId('managed-picker.controller.chip')).toBeNull();
    await act(async () => screen.pressByTestId(`managed-picker.home:${first}`));
    // The Home's only machine that can manage is preselected in the scope chip, so its catalog is the first frame.
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('managed-picker.controller.chip'),
      ).not.toBeNull(),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.provisioners.list').length >
          0 ||
          screen.tree.findAll(
            (node) => node.props.testID === 'managed-picker.unavailable',
          ).length > 0,
      ).toBe(true),
    );
    expect(
      harness.requestsFor('/v1/actions/machines.provisioners.list'),
    ).toHaveLength(1);
    expect(
      harness.requestsFor('/v1/actions/machines.provisioners.list')[0],
    ).toMatchObject({
      serverId: first,
      input: {
        target: { kind: 'machine', machineId: 'build-controller' },
        input: {
          homeId: 'srv_build',
          controller: {
            machineId: 'build-controller',
            installationId: 'build-installation',
          },
        },
      },
    });
    expect(
      harness.requests.some((request) => request.path.endsWith('/acquire')),
    ).toBe(false);
    await screen.unmount();
  });
  it.each(['profile', 'portable'] as const)('retains a draft\'s named offline controller under its chip for a %s Home identifier, and offers setup when nothing can manage', async (identifierKind) => {
    const serverId = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    const scopeId = identifierKind === 'portable' ? 'srv_build' : serverId;
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        srv_build: [
          createMachineFixture({
            id: 'asleep',
            installationId: 'installation',
            active: false,
            activeAt: 0,
            kind: 'persistent',
          }),
        ],
      },
      machineListStatusByServerId: { srv_build: 'loading' },
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const { useManagedControllerScope } = await import('./useManagedControllerScope');
    const { useMachineListStatusForServer } = await import('@/sync/domains/state/storage');
    const controllerScope = await renderHook(() => ({
      scope: useManagedControllerScope({ serverId: scopeId, preferred: { machineId: 'asleep', installationId: 'installation' }, testIDPrefix: 'scope-probe' }),
      status: useMachineListStatusForServer(scopeId),
    }));
    expect(controllerScope.getCurrent().status).toBe('loading');
    expect(controllerScope.getCurrent().scope.controller).toEqual({ machineId: 'asleep', installationId: 'installation' });
    await act(async () => { storage.setState({ machineListStatusByServerId: { srv_build: 'idle' } }); });
    expect(controllerScope.getCurrent().status).toBe('idle');
    await controllerScope.unmount();
    function NamedOfflinePicker() {
      const scope = useManagedControllerScope({ serverId: scopeId, preferred: { machineId: 'asleep', installationId: 'installation' }, testIDPrefix: 'managed-picker.controller' });
      return <>{scope.chip}<MachineProvisionerPicker serverId={scopeId} scope={scope} /></>;
    }
    const screen = await renderPicker(<NamedOfflinePicker />);
    expect(
      screen.findByTestId('managed-picker.controller.chip'),
    ).not.toBeNull();
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-picker.offline')).not.toBeNull(),
    );
    expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
    await screen.unmount();

    storage.setState({
      machineListByServerId: {
        srv_build: [
          createMachineFixture({ id: 'plain', installationId: null }),
        ],
      },
    });
    const onSetUpThisComputer = vi.fn();
    const empty = await renderPicker(
      <MachineProvisionerPicker
        serverId={scopeId}
        onSetUpThisComputer={onSetUpThisComputer}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(empty.findByTestId('managed-picker.no-controller')).not.toBeNull(),
    );
    await act(async () =>
      empty.pressByTestId('managed-picker.no-controller-action'),
    );
    expect(onSetUpThisComputer).toHaveBeenCalledTimes(1);
    await empty.unmount();
  });
  it('waits for the Home\u2019s machine list instead of saying no machine can create machines', async () => {
    const homeId = await harness.addHome({ name: 'Build', serverUrl: 'https://unsynced-picker.example', serverIdentityId: 'srv_unsynced_picker', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
    const screen = await renderPicker(<MachineProvisionerPicker serverId={homeId} />);
    expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
    expect(screen.findByTestId('managed-picker.machines-loading')).not.toBeNull();
    await act(async () => storage.setState({ machineListByServerId: { [homeId]: [] }, machineListStatusByServerId: { [homeId]: 'idle' } }));
    expect(screen.findByTestId('managed-picker.no-controller')).not.toBeNull();
    await act(async () => storage.setState({ machineListStatusByServerId: { [homeId]: 'error' }, machineListByServerId: { [homeId]: null } }));
    expect(screen.findByTestId('managed-picker.no-controller')).toBeNull();
    expect(screen.findByTestId('managed-picker.machines-unavailable')).not.toBeNull();
    await screen.unmount();
  });
  it('uses the scope a page put in its own header, drawing no second chip and keeping the controller state', async () => {
    const serverId = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({
      machineListByServerId: {
        [serverId]: [
          createMachineFixture({
            id: 'asleep',
            installationId: 'installation',
            active: false,
            activeAt: 0,
            kind: 'persistent',
          }),
        ],
      },
      machineListStatusByServerId: { [serverId]: 'idle' },
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const { useManagedControllerScope } =
      await import('./useManagedControllerScope');
    function PageWithHeaderScope() {
      const scope = useManagedControllerScope({
        serverId,
        preferred: { machineId: 'asleep', installationId: 'installation' },
        testIDPrefix: 'page.controller',
      });
      return (
        <>
          {scope.chip}
          <MachineProvisionerPicker serverId={serverId} scope={scope} />
        </>
      );
    }
    const screen = await renderPicker(<PageWithHeaderScope />);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-picker.offline')).not.toBeNull(),
    );
    expect(screen.findByTestId('page.controller.chip')).not.toBeNull();
    expect(screen.findByTestId('managed-picker.controller.chip')).toBeNull();
    expect(screen.findByTestId('managed-picker.scope')).toBeNull();
    await screen.unmount();
  });
  it('settles a signed-out Home without an endless provisioning spinner or reading a different Home', async () => {
    const signedOut = await harness.addHome({
      name: 'Signed out',
      serverUrl: 'https://signed-out.example',
      serverIdentityId: 'srv_signed_out',
      accountId: null,
    });
    await harness.addHome({
      name: 'Other',
      serverUrl: 'https://other.example',
      serverIdentityId: 'srv_other',
      accountId: 'other',
    });
    const { MachineProvisionerPicker } =
      await import('./MachineProvisionerPicker');
    const screen = await renderPicker(
      <MachineProvisionerPicker serverId={signedOut} />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.tree.findAll(
          (node) => node.props.testID === 'managed-picker.unavailable',
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(
      harness.requestsFor(
        '/v1/machines/managed/actions/machines.provisioners.list',
      ),
    ).toHaveLength(0);
    await screen.unmount();
  });
});
