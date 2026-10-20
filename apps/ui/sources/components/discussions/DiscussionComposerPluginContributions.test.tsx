import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { flushHookEffects, renderWithAppProviders, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DiscussionComposerValue } from './DiscussionComposer';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/discussions/discussion-1', segments: ['(app)', 'discussions', '[discussionId]'] }).module;
});

// Install only genuine transport/device boundaries before loading the real
// Sync, Administration, projection cache and Composer presentation owners.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { normalizePluginUiProjection, EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { DiscussionComposerPluginContributions } = await import('./DiscussionComposerPluginContributions');
const { DiscussionComposer } = await import('./DiscussionComposer');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
afterAll(async () => { await network.dispose(); });

const PLUGIN_ID = 'acme.discussion';
const SERVER_IDENTITY = 'srv_discussion_composer_plugins';
const SELECTED_MACHINE = 'machine-selected';
const OTHER_MACHINE = 'machine-other';
const COMPOSER = Object.freeze({ kind: 'discussion' as const, discussionId: 'discussion-1' });
const sourceCustody = Object.freeze({ kind: 'development' as const, registeredRootId: 'discussion-plugin-source' });
const originFor = (machineId: string) => PluginMachineExecutionOriginV1Schema.parse({
    serverIdentityId: SERVER_IDENTITY, sourceRef: { machineId, pluginId: PLUGIN_ID, sourceCustody },
});

function OfferedControls(props: Readonly<{ controlIds: readonly (string | undefined)[] }>): React.ReactElement {
    return React.createElement('offered-controls', props);
}

function ControlledDiscussionComposer(props: Readonly<{
    lifetime: React.ComponentProps<typeof DiscussionComposer>['accountLifetime'];
}>): React.ReactElement {
    const [draft, setDraft] = React.useState<DiscussionComposerValue>({ text: 'Please review this.', mentions: [] });
    return <DiscussionComposer scope={props.lifetime.scope} accountLifetime={props.lifetime}
        address={{ serverId: props.lifetime.scope.serverId }} discussionId={COMPOSER.discussionId}
        availability="available" value={draft} onChange={setDraft} disabled={false} onSend={() => {}} />;
}

function rawProjection(machineId: string, occurrenceId: string, includeOtherControls = false) {
    const control = (pluginId: string, localId: string, scopes: readonly string[]) => ({
        id: `${pluginId}/${localId}`, pluginId, identity: { pluginId, localId }, occurrenceId,
        definition: { id: localId, label: `${machineId}:${localId}`, icon: 'preview', scopes,
            interaction: { kind: 'action', action: 'review' } },
    });
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 7,
        installedPackagesById: { [PLUGIN_ID]: { id: PLUGIN_ID, displayName: 'Discussion helper', version: '1.0.0',
            enabled: true, occurrenceId, source: { kind: 'localPath', locator: 'discussion-plugin-source' },
            sourceCustody, executionOrigin: originFor(machineId), executionTarget: { default: 'installation' } } },
        familiesById: { composerControls: { family: 'composerControls', entriesById: {
            [`${PLUGIN_ID}/review`]: control(PLUGIN_ID, 'review', ['discussion']),
            ...(includeOtherControls ? {
                'other.plugin/leak': control('other.plugin', 'leak', ['discussion']),
                [`${PLUGIN_ID}/session-only`]: control(PLUGIN_ID, 'session-only', ['session']),
            } : {}),
        } } },
    });
}

describe('Discussion Composer installed-plugin contributions', () => {
    let serverId: string;
    let lifetime: NonNullable<ReturnType<typeof captureActiveServerAccountScopeLifetime>>;
    let responseProjection: ReturnType<typeof rawProjection>;
    const requestedMachines: string[] = [];

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        clearDaemonMergedProjectionCacheForTests();
        requestedMachines.length = 0;
        const url = 'https://discussion-composer-plugins.example.test';
        await network.addHome(url, 'account-discussion');
        await setServerProfileIdentityForUrl(url, SERVER_IDENTITY);
        const home = await network.addHome(url, 'account-discussion');
        serverId = home.id;
        network.setHttpResponder(async (input, init) => {
            const pathname = new URL(String(input)).pathname;
            return pathname === '/v1/machines'
                ? Response.json({ machines: [OTHER_MACHINE, SELECTED_MACHINE].map(id => createPlainMachineRowFixture({ id, accountId: 'account-discussion' })) })
                : createEmptyAccountBootstrapHttpResponse(pathname, init);
        });
        responseProjection = rawProjection(SELECTED_MACHINE, 'occurrence-a', true);
        network.setRpcAckResponder(async request => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            requestedMachines.push(request.targetId);
            return { ok: true, result: { protocolVersion: 1, projection: responseProjection } };
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        const captured = captureActiveServerAccountScopeLifetime();
        if (!captured) throw new Error('Account restoration must establish the real lifetime');
        lifetime = captured;
        const machines = [OTHER_MACHINE, SELECTED_MACHINE].map(id => createMachineFixture({ id, activeAt: Date.now() }));
        storage.setState({ isDataReady: true, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [serverId]: machines, [SERVER_IDENTITY]: machines },
            machineListStatusByServerId: { [serverId]: 'idle', [SERVER_IDENTITY]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference({}, PLUGIN_ID, originFor(SELECTED_MACHINE)) } });
        clearDaemonMergedProjectionCacheForTests();
    });

    afterEach(async () => {
        standardCleanup();
        clearPluginAccountAvailabilityProjection();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    function accountProjection(phase: 'current' | 'unavailable' = 'current') {
        return unionPluginUiProjections([OTHER_MACHINE, SELECTED_MACHINE].map(machineId => ({
            machineId, serverId, serverIdentityId: SERVER_IDENTITY, phase, interactionEnabled: phase === 'current',
            projection: normalizePluginUiProjection(rawProjection(machineId, 'occurrence-a')),
        })), new Map([[PLUGIN_ID, originFor(SELECTED_MACHINE)]])).pluginUiProjection;
    }

    function renderContributions(projection = accountProjection(), enabled = true, content?: React.ReactNode) {
        return <AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: null, serverId: null, platform: 'web', accountLifetime: lifetime,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {},
        }}>{content ?? <DiscussionComposerPluginContributions composer={COMPOSER} lifetime={lifetime} enabled={enabled}>
            {slots => <OfferedControls controlIds={slots.extraActionChips.map(chip => chip.controlId)} />}
        </DiscussionComposerPluginContributions>}</AppShellPluginUiProjectionValueProvider>;
    }

    it('renders only the selected source control in the actual Discussion chip rail and withdraws it with projection and scope', async () => {
        const composer = <ControlledDiscussionComposer lifetime={lifetime} />;
        const renderComposer = (projection = accountProjection()) => renderContributions(projection, true, composer);
        const rendered = await renderWithAppProviders(renderComposer());
        const chipHosts = (id: string) => rendered.tree.root.findAll(node => typeof node.type === 'string'
            && node.props.testID === `plugin-composer-control:${id}`);
        await waitForHomeGovernance(() => expect(chipHosts(`${PLUGIN_ID}/review`).length).toBeGreaterThan(0));
        expect(chipHosts(`${PLUGIN_ID}/review`)[0]!.props.accessibilityLabel).toBe(`${SELECTED_MACHINE}:review`);
        expect(chipHosts('other.plugin/leak')).toEqual([]);
        expect(chipHosts(`${PLUGIN_ID}/session-only`)).toEqual([]);
        expect(requestedMachines.length).toBeGreaterThan(0);
        expect(new Set(requestedMachines)).toEqual(new Set([SELECTED_MACHINE]));
        await rendered.update(renderComposer(EMPTY_PLUGIN_UI_PROJECTION));
        expect(chipHosts(`${PLUGIN_ID}/review`)).toEqual([]);
        await rendered.update(renderComposer());
        await waitForHomeGovernance(() => expect(chipHosts(`${PLUGIN_ID}/review`).length).toBeGreaterThan(0));
        await act(async () => storage.getState().activateProfileScope({ serverId, accountId: 'replacement-account' }));
        await rendered.update(renderComposer());
        expect(lifetime.isCurrent()).toBe(false);
        expect(chipHosts(`${PLUGIN_ID}/review`)).toEqual([]);
        await rendered.unmount();
    });

    it('refuses a cached daemon replacement occurrence until the Account supply matches it', async () => {
        responseProjection = rawProjection(SELECTED_MACHINE, 'occurrence-b', true);
        const cached = await loadDaemonMergedProjectionCacheEntry({ machineId: SELECTED_MACHINE, serverId, accountLifetime: lifetime });
        expect(cached?.kind).toBe('ready');
        if (cached?.kind !== 'ready') throw new Error('The genuine daemon cache must contain the replacement fixture');
        expect(cached.inputs.pluginProjectionById[PLUGIN_ID]?.occurrenceId).toBe('occurrence-b');
        const rendered = await renderWithAppProviders(renderContributions());
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(new Set(requestedMachines)).toEqual(new Set([SELECTED_MACHINE]));
        expect(rendered.tree.root.findByType(OfferedControls).props.controlIds).toEqual([]);
        await rendered.unmount();
    });

    it('offers no control and invents no Machine when declarations or an executable supply are absent', async () => {
        const rendered = await renderWithAppProviders(renderContributions(EMPTY_PLUGIN_UI_PROJECTION));
        const offered = () => rendered.tree.root.findByType(OfferedControls).props.controlIds;
        expect(offered()).toEqual([]);
        expect(requestedMachines).toEqual([]);
        await rendered.update(renderContributions(accountProjection('unavailable')));
        await flushHookEffects();
        expect(offered()).toEqual([]);
        expect(requestedMachines).toEqual([]);
        await rendered.update(renderContributions(accountProjection(), false));
        expect(offered()).toEqual([]);
        expect(requestedMachines).toEqual([]);
        await rendered.unmount();
    });
});
