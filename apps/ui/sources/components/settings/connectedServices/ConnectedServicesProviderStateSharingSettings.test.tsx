import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, renderHook, standardCleanup } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';

const confirm = vi.hoisted(() => vi.fn<(...args: Parameters<typeof import('@/modal').Modal.confirm>) => Promise<boolean>>());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm } }).module;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSetting } = await import('@/sync/store/hooks');
const { getAgentCore } = await import('@/agents/catalog/catalog');
const { ConnectedServicesProviderStateSharingDisclosure } = await import('./ConnectedServicesProviderStateSharingSettings');
const { ProviderStateSharingRows } = await import('./ProviderStateSharingRow');
const { resolveProviderStateSharingAgentIds } = await import('./providerStateSharingSettings');
const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection, retirePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;
const externalPluginId = 'com.acme.sharing';
const externalAgentId = `${externalPluginId}/assistant`;

function admitSharingCatalog(options: Readonly<{
    external?: boolean;
    incomplete?: boolean;
    pluginId?: string;
    localId?: string;
    additionalPrivacyRisk?: boolean;
}> = {}) {
    if (!options.external) {
        replacePluginAccountAvailabilityProjection({ scope: account.scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [], inventoryComplete: !options.incomplete,
        } });
        return;
    }
    const pluginId = options.pluginId ?? externalPluginId;
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 1,
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: { pluginId, desiredVersion: '1.0.0', enabled: true,
            offlineUiHosting: 'disabled', writableCollections: [], revision: 'sharing-release' },
        release: { ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Acme Agent',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { agents: [{
                    id: options.localId ?? 'assistant', title: 'Acme Agent', runtime: { kind: 'custom' }, primary: 'sessions', capabilities: {
                        sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                        providerStateSharing: { config: { supported: false, modes: ['isolated'] }, state: {
                            supported: true, modes: ['shared', 'isolated'], sharedStatePrivacyRiskAcknowledgementRequired: true,
                        } },
                    },
                }] } }, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        }, packageAssets: [], uiArtifacts: [],
    });
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: 'srv_sharing', machineId: 'sharing-machine', materializationId: 'sharing-install',
        pluginId, version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
        archiveDigestSha256: response.release!.archiveDigestSha256, declaredManifest: response.release!.normalizedManifest,
        uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: 1_700_000_000_000,
    });
    const releases = [response.release!];
    const materializations = [materialization];
    if (options.additionalPrivacyRisk !== undefined) {
        const release = response.release!;
        const definition = release.normalizedManifest.contributes.agents![0]!;
        const capability = definition.capabilities.providerStateSharing!;
        const alternate = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...response,
            intent: { ...response.intent!, desiredVersion: '2.0.0' },
            release: { ...release, ref: { pluginId, version: '2.0.0' }, archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                normalizedManifest: { ...release.normalizedManifest, version: '2.0.0', contributes: { agents: [{
                    ...definition, capabilities: { ...definition.capabilities, providerStateSharing: { ...capability,
                        state: { ...capability.state, sharedStatePrivacyRiskAcknowledgementRequired: options.additionalPrivacyRisk },
                    } },
                }] } },
            },
        }).release!;
        releases.push(alternate);
        materializations.push(PluginMachineMaterializationV1Schema.parse({ ...materialization,
            materializationId: 'sharing-install-2', machineId: 'sharing-machine-2', version: '2.0.0',
            archiveDigestSha256: alternate.archiveDigestSha256, declaredManifest: alternate.normalizedManifest,
        }));
    }
    replacePluginAccountAvailabilityProjection({ scope: account.scope, snapshot: { availabilityCursor: 1,
        // With no Account-selected version, each Machine's exact portable
        // release remains independently admitted by Availability.
        intentReads: [{ pluginId, response: options.additionalPrivacyRisk === undefined ? response
            : { ...response, intent: null, release: null } }],
        releases,
        materializations,
        snapshots: materializations.map(installed => ({ serverIdentityId: installed.serverIdentityId,
            machineId: installed.machineId, materializations: [installed] })),
        inventoryComplete: !options.incomplete,
    } });
}

function SharingControls({ perAgent }: Readonly<{ perAgent: boolean }>) {
    const settings = useSetting('connectedServicesProviderStateSharingSettingsV1');
    return perAgent
        ? <ProviderStateSharingRows agentId="codex" agentTitle="Codex"
            capability={getAgentCore('codex')?.connectedServices?.providerStateSharing} settings={settings} />
        : <ConnectedServicesProviderStateSharingDisclosure settings={settings} agentIds={['codex']} />;
}
async function startSharing(perAgent: boolean) {
    const screen = await renderScreen(<SharingControls perAgent={perAgent} />);
    if (!perAgent) await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');
    const id = perAgent ? 'connected-services-provider-state-sharing-agent-codex-state'
        : 'connected-services-provider-state-sharing-state-default';
    let pending!: Promise<void>;
    await act(async () => { pending = screen.tree.root.findAllByProps({ testID: id })[0]!.props.rightElement.props.onValueChange(true); });
    return { screen, pending };
}

describe('provider state sharing through configurable Account Action approval', () => {
    beforeEach(async () => {
        confirm.mockReset();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockImplementation(confirm);
        account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        }, connectedServicesProviderStateSharingSettingsV1: { v: 1,
            defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } }) });
        // Credential-scope readiness is asynchronous; mounted controls use the
        // exact admitted Home rather than the old debounce-only settings stub.
        const { useSettingActionWriter } = await import('@/components/settings/catalog/useSettingActionWriter');
        const readiness = await renderHook(() => useSettingActionWriter());
        await vi.waitFor(() => expect(readiness.getCurrent().isCurrent()).toBe(true));
        admitSharingCatalog();
    });
    afterEach(async () => { standardCleanup(); clearPluginAccountAvailabilityProjection(); await account?.dispose(); storage.setState(originalState, true); });

    it.each([false, true])('retains external privacy consent while changing sharing beside bundled Agents (perAgent=%s)', async perAgent => {
        admitSharingCatalog({ external: true });
        expect(resolveProviderStateSharingAgentIds()).toContain(externalAgentId);
        const { pending } = await startSharing(perAgent);
        await act(async () => { await pending; });
        const actual = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        expect(perAgent ? actual.byAgentId.codex?.stateMode : actual.defaults.stateMode).toBe('shared');
        expect(actual.acknowledgedRisksByAgentId.codex?.sharedStatePrivacy).toBe(true);
        if (!perAgent) expect(actual.acknowledgedRisksByAgentId[externalAgentId]?.sharedStatePrivacy).toBe(true);
        expect(account.settingsWrites.length).toBeGreaterThan(0);
    });

    it('retains every current installation privacy risk for the same external Agent', async () => {
        admitSharingCatalog({ external: true, additionalPrivacyRisk: false });
        const { pending } = await startSharing(false);
        await act(async () => { await pending; });
        const actual = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        expect(actual.defaults.stateMode).toBe('shared');
        expect(actual.acknowledgedRisksByAgentId[externalAgentId]?.sharedStatePrivacy).toBe(true);
    });

    it('keeps external installations qualified beside a bundled Agent with the same contribution identity', async () => {
        admitSharingCatalog({ external: true, pluginId: 'happier.agent.codex', localId: 'codex' });
        const { pending } = await startSharing(false);
        await act(async () => { await pending; });
        const actual = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        expect(actual.defaults.stateMode).toBe('shared');
        expect(actual.acknowledgedRisksByAgentId.codex?.sharedStatePrivacy).toBe(true);
        expect(actual.acknowledgedRisksByAgentId['happier.agent.codex/codex']?.sharedStatePrivacy).toBe(true);
    });

    it.each<{ stateMode: 'isolated' } | { configMode: 'copied' }>([{ stateMode: 'isolated' }, { configMode: 'copied' }])(
        'keeps non-sharing changes available without a sharing catalog (%j)', async change => {
            clearPluginAccountAvailabilityProjection();
            const { useSettingActionWriter } = await import('@/components/settings/catalog/useSettingActionWriter');
            const { CONNECTED_SERVICES_SETTINGS } = await import('./connectedServicesSettings');
            const writer = await renderHook(() => useSettingActionWriter());
            await act(async () => {
                await writer.getCurrent()(CONNECTED_SERVICES_SETTINGS.settings.sharingPerAgent, { agentId: 'codex', ...change });
            });
            expect(account.persistedSettings.connectedServicesProviderStateSharingSettingsV1.byAgentId.codex).toEqual(change);
            expect(account.settingsWrites.length).toBeGreaterThan(0);
        },
    );

    it.each(['unavailable', 'incomplete', 'retired'] as const)('refuses a %s sharing catalog before writing Account settings', async state => {
        admitSharingCatalog({ external: state !== 'unavailable', incomplete: state === 'incomplete' });
        if (state === 'unavailable') clearPluginAccountAvailabilityProjection();
        if (state === 'retired') retirePluginAccountAvailabilityProjection([externalPluginId]);
        expect(resolveProviderStateSharingAgentIds()).toContain('codex');
        const before = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        const { pending } = await startSharing(false);
        await act(async () => { await pending; });
        expect(account.persistedSettings.connectedServicesProviderStateSharingSettingsV1).toEqual(before);
        expect(account.settingsWrites).toEqual([]);
    });

    it('refuses retired external declaration authority during an Account CAS rebase', async () => {
        admitSharingCatalog({ external: true });
        const before = account.persistedSettings;
        const request = account.request.getMockImplementation()!;
        let raced = false;
        account.request.mockImplementation(async (input, init) => {
            if (!raced && new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                raced = true;
                retirePluginAccountAvailabilityProjection([externalPluginId]);
                account.replaceSettings(before, { version: 2, publish: false });
            }
            return await request(input, init);
        });
        const { pending } = await startSharing(false);
        await act(async () => { await pending; });
        expect(raced).toBe(true);
        expect(account.persistedSettings.connectedServicesProviderStateSharingSettingsV1).toEqual(before.connectedServicesProviderStateSharingSettingsV1);
        expect(account.settingsWrites).toHaveLength(1);
    });

    it('routes the Permissions page Agent default through the same configurable Action', async () => {
        const { PermissionsSettingsView } = await import('../session/PermissionsSettingsView');
        const target = 'agent:happier.agent.codex/codex';
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        })); });
        const screen = await renderScreen(<PermissionsSettingsView />);
        const picker = () => screen.tree.root.findAll(node => typeof node.props.onSelect === 'function'
            && node.props.itemTrigger?.itemProps?.testID === 'settings-permissions-default-codex')[0]!;
        await act(async () => { picker().props.onSelect('default'); });
        expect(storage.getState().settings.sessionDefaultPermissionModeByTargetKey[target]).toBeUndefined();
        expect(account.settingsWrites).toEqual([]);
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        })); });
        await act(async () => { picker().props.onSelect('default'); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionDefaultPermissionModeByTargetKey[target]).toBe('default'));
    });

    it.each([false, true])('rebases sharing without losing concurrent preferences (perAgent=%s)', async perAgent => {
        confirm.mockResolvedValue(false);
        const current = account.persistedSettings;
        const sharing = { ...current.connectedServicesProviderStateSharingSettingsV1,
            defaults: { configMode: 'copied' as const, stateMode: 'isolated' as const },
            byAgentId: { claude: { configMode: 'isolated' as const }, codex: { configMode: 'copied' as const } },
            acknowledgedRisksByAgentId: { claude: { sharedStatePrivacy: true as const } },
        };
        const request = account.request.getMockImplementation()!;
        let raced = false;
        // The HTTP CAS boundary races after the Action has prepared its intent.
        account.request.mockImplementation(async (input, init) => {
            if (!raced && new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                raced = true;
                account.replaceSettings({ ...current, connectedServicesProviderStateSharingSettingsV1: sharing }, { version: 2, publish: false });
            }
            return await request(input, init);
        });
        const { pending } = await startSharing(perAgent);
        await act(async () => { await pending; });
        expect(confirm).not.toHaveBeenCalled();
        const actual = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        expect(actual.defaults).toEqual({ ...sharing.defaults, stateMode: perAgent ? 'isolated' : 'shared' });
        expect(actual.byAgentId).toEqual({ ...sharing.byAgentId, codex: { configMode: 'copied', ...(perAgent ? { stateMode: 'shared' } : {}) } });
        const expectedAcknowledgements = { ...sharing.acknowledgedRisksByAgentId, codex: { sharedStatePrivacy: true } };
        if (perAgent) expect(actual.acknowledgedRisksByAgentId).toEqual(expectedAcknowledgements);
        else expect(actual.acknowledgedRisksByAgentId).toMatchObject(expectedAcknowledgements);
        expect(raced).toBe(true);
    });
    it.each([false, true])('keeps Account settings unchanged when its Action is disabled (perAgent=%s)', async perAgent => {
        confirm.mockResolvedValue(false);
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        })); });
        const before = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        const { pending } = await startSharing(perAgent);
        await act(async () => { await pending; });
        expect(confirm).not.toHaveBeenCalled();
        expect(account.persistedSettings.connectedServicesProviderStateSharingSettingsV1).toEqual(before);
        expect(account.settingsWrites).toEqual([]);
    });
});
