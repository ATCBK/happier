import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { t } from '@/text';
import type { NewSessionEmbeddedHost } from '@/components/sessions/new/navigation/newSessionHost';
import { settingsDefaults } from '@/sync/domains/settings/settings';

it('fills the global draft from offline last-report prompts without sending or selecting the offline machine', async () => {
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_offline_prompts';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://offline-prompts.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-offline-prompts', active: false, activeAt: 1 });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true,
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machine.id} machineName="Laptop" />);
    const list = () => screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    expect(screen.root.findAllByType(NewSessionEmbeddedHostProvider)).toHaveLength(0);
    const scope = captureActiveServerAccountScopeLifetime()!.scope;
    for (const kind of ['lastReport', 'lastStorageReport', 'notifyWhenBack']) {
        const suggestion = list().props.suggestions.find((entry: { kind: string }) => entry.kind === kind);
        expect(suggestion).toBeDefined();
        const testId = `hub-composer.suggestion.${suggestion.id}`;
        expect(screen.findByTestId(testId)?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync(testId);
        expect(routePush).toHaveBeenLastCalledWith({ pathname: '/new', params: {
            draftId: expect.any(String), draftServerId: scope.serverId, draftAccountId: scope.accountId,
        } });
        const route = routePush.mock.lastCall![0] as { params: { draftId: string } };
        const draft = readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId });
        expect(draft?.input).toBe(suggestion.fill.text);
        expect(draft?.selectedMachineId).toBeNull();
        expect(draft?.executionTarget).toBeNull();
        if (kind === 'notifyWhenBack') {
            const { SettingsDeclarationActionInputSchemasV1 } = await import('@happier-dev/protocol/actions/settingsDeclarationActionFamily');
            const input = SettingsDeclarationActionInputSchemasV1['settings.set'].parse(JSON.parse(draft!.input.split('\nsettings.set ')[1]!));
            expect(input).toEqual({ anchor: 'notifications.machineOffline', key: machine.id, value: true });
        }
    }
    expect(storage.getState().sessions).toEqual({});
    expect(rpc).not.toHaveBeenCalled();
    await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, active: true, activeAt: Date.now() }] } }));
    await act(async () => list().props.onFill({ prompt: 'Inspect the current report', placement: { serverId, machineId: machine.id } }));
    const host: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(host.params.prompt).toBe('Inspect the current report');
    expect(host.params.machineId).toBe(machine.id);
    await screen.unmount();
});

it('does not seed an offline machine alert prompt into another Home’s active Account during a page switch', async () => {
    await prepareSessionDraftPersistenceStorage();
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://active-home.example.test', serverIdentityId: 'srv_active_home' });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'foreign-machine', active: false, activeAt: 1 });
    storage.setState({ isDataReady: true, isSessionDraftsReady: true,
        machineListByServerId: { 'srv_foreign_home': [machine] }, machineListStatusByServerId: { 'srv_foreign_home': 'idle' } });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId="srv_foreign_home" machineId={machine.id} machineName="Studio" />);
    const list = screen.root.findAll(node => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0]!;
    const suggestion = list.props.suggestions.find((entry: { kind: string }) => entry.kind === 'notifyWhenBack');
    await screen.pressByTestIdAsync(`hub-composer.suggestion.${suggestion.id}`);
    expect(routePush).not.toHaveBeenCalled();
    expect(storage.getState().sessions).toEqual({});
    expect(rpc).not.toHaveBeenCalled();
    await screen.unmount();
});

// Native hosts and transport are the boundaries. The real embedded New Session,
// resource store, passive summary hook and suggestion projection remain mounted.
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => vi.fn());
const routePush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: routePush },
}).module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
await loadSyncSingletonForTests();
const { HubComposerSuggestionList } = await import('@/components/hub/composer/suggestions/HubComposerSuggestions');
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { warmMachineResourceSummaries } = await import('@/sync/domains/machines/resources/warmMachineResourceSummaries');
const { MachineResourcesAskBlock } = await import('./MachineResourcesAskBlock');
const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
const { useNewSessionMachinePathState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionMachinePathState');
const { useNewSessionServerTargetState } = await import('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');

it('recovers the mounted Ask composer from canonical presence without requiring a caller update', async () => {
    const serverId = 'srv_presence';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://presence.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-presence', active: false, activeAt: 1 });
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId={machine.id} machineName="Laptop" />);
    const composers = () => screen.root.findAllByType(NewSessionEmbeddedHostProvider);
    expect(composers()).toHaveLength(0);
    await act(async () => storage.setState({ machineListByServerId: { [serverId]: [{ ...machine, active: true, activeAt: Date.now() }] } }));
    expect(composers()).toHaveLength(1);
    await act(async () => storage.setState({ machineListByServerId: { [serverId]: [machine] } }));
    expect(composers()).toHaveLength(0);
    await screen.unmount();
});

it('starts Ask on the page machine and home folder before intent, independently of a foreign remembered placement', async () => {
    const serverId = 'srv_placement';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://placement.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() });
    const homeDir = machine.metadata?.homeDir;
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId="machine-a" machineName="Laptop" />);
    const host: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    const targetServer = await renderHook((hostTargetServerId: string | undefined) => useNewSessionServerTargetState({
        settings: { ...settingsDefaults, serverSelectionActiveTargetKind: 'server', serverSelectionActiveTargetId: 'home-b' },
        activeServerId: 'home-b',
        serverProfiles: [
            { id: serverId, serverUrl: 'https://placement.example.test', name: 'Home A', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
            { id: 'home-b', serverUrl: 'https://home-b.example.test', name: 'Home B', createdAt: 2, updatedAt: 2, lastUsedAt: 2 },
        ],
        hostTargetServerId,
        request: { spawnServerIdParam: typeof host.params.spawnServerId === 'string' ? host.params.spawnServerId : null },
    }), { initialProps: host.targetServerId });
    expect(targetServer.getCurrent().targetServerId).toBe(serverId);
    expect(targetServer.getCurrent().allowedTargetServerIds).toEqual([serverId]);
    expect(targetServer.getCurrent().showServerPickerChip).toBe(false);
    const placement = await renderHook(() => useNewSessionMachinePathState({
        serverId: targetServer.getCurrent().targetServerId,
        machines: [machine, createMachineFixture({ id: 'machine-b' })],
        recentMachinePaths: [{ machineId: 'machine-b', path: '/foreign/repo' }],
        machineIdParam: host.params.machineId,
        pathParam: host.params.directory,
        persistedExecutionTarget: { kind: 'machine', target: { serverId: 'home-b', machineId: 'machine-b' } },
        persistedPath: '/foreign/repo',
    }));
    expect(placement.getCurrent().executionTarget).toEqual({ kind: 'machine', target: { serverId, machineId: 'machine-a' } });
    expect(placement.getCurrent().directoryIntent).toEqual({ kind: 'path', path: homeDir });
    expect(host.demanded).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(host.params.draftOrigin).toBeUndefined();
    await act(async () => host.setParams({ directory: '/authored/repo', resumeSessionId: 'foreign-session' }));
    const editedHost: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(editedHost.params.directory).toBe('/authored/repo');
    await act(async () => editedHost.openDraft({ draftId: '4db4aa44-4b4a-4444-8444-4b4a4b4a4b4a', draftOrigin: 'ordinary' }));
    const restartedHost: NewSessionEmbeddedHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    expect(restartedHost.params.directory).toBe(homeDir);
    expect(restartedHost.params.resumeSessionId).toBeUndefined();
    expect(restartedHost.params.machineId).toBe('machine-a');
    expect(restartedHost.params.draftOrigin).toBeUndefined();
    await targetServer.rerender('unavailable-home');
    expect(targetServer.getCurrent().targetServerId).toBe('unavailable-home');
    expect(targetServer.getCurrent().targetServerProfile).toBeNull();
    expect(targetServer.getCurrent().allowedTargetServerIds).toEqual(['unavailable-home']);
    await placement.unmount();
    await targetServer.unmount();
    await screen.unmount();
});

afterEach(() => {
    standardCleanup();
    machineResourceStore.reset();
    storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
    rpc.mockReset();
    routePush.mockReset();
});

it('mounts Ask with a real warmed summary and reads calm from canonical attention, not the value payload', async () => {
    const consoleErrors = vi.spyOn(console, 'error');
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_home_a';
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.example.test', serverIdentityId: serverId });
    onTestFinished(() => connection.dispose());
    const sampledAt = Date.now();
    const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: sampledAt, daemonStateVersion: 1, daemonState: {
        resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'calm', reasons: [] } },
    } });
    // This fixture supplies an already-hydrated Account snapshot, as screen testkits do.
    storage.setState({ isDataReady: true, isSessionDraftsReady: true, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    rpc.mockResolvedValue({ state: 'reporting', sample: {
        v: 1, sampledAt, intervalMs: 15_000, cpu: { reported: true, busyPct: 20 },
        memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
    }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } });
    await warmMachineResourceSummaries([{ serverId, machineId: 'machine-a' }]);
    const screen = await renderScreen(<MachineResourcesAskBlock serverId={serverId} machineId="machine-a" machineName="Laptop" />);
    const overviewReason = () => {
        // The one suggestions surface the block mounts; its list is the derivation's output.
        const list = screen.root.findAll((node) => node.type === Reflect.get(HubComposerSuggestionList, 'type'))[0];
        const suggestions = (list?.props.suggestions ?? []) as readonly Readonly<{ kind?: string; reason?: string }>[];
        return suggestions.find((suggestion) => suggestion.kind === 'overview')?.reason;
    };
    expect(overviewReason()).toBe(t('machineResources.askSuggestions.reasons.calm'));
    const placeholder = t('machineResources.ask.placeholder', { machine: 'Laptop' });
    expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props?.placeholder === placeholder).length).toBeGreaterThan(0);
    // Canonical attention can require the person even when every metric stays calm.
    await act(async () => storage.getState().applyMachines([{ ...machine,
        daemonStateVersion: 2, daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
            host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'needs_you', reasons: [] } } },
    }], true, { sourceServerId: serverId }));
    expect(overviewReason()).toBe(t('machineResources.askSuggestions.reasons.currentReport'));
    expect(consoleErrors.mock.calls.filter((args) => args.some((arg) => typeof arg === 'string'
        && /Cannot update a component.*while rendering/.test(arg)))).toEqual([]);
    await screen.unmount();
});
