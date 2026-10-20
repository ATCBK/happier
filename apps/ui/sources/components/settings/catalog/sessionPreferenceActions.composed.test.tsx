import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import axios, { type AxiosAdapter } from 'axios';

import { renderHook } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useSettingMutable } from '@/sync/store/hooks';
import { connectedServiceProfileKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { useConnectedAccountPinnedMeters } from '@/components/settings/connectedServices/usage/useConnectedAccountPinnedMeters';
import { createCliActionExecutorFromCredentials } from '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '../../../../../cli/src/settings/actionsSettingsProvider';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const originalAxiosAdapter = axios.defaults.adapter;
afterEach(() => { standardCleanup(); storage.setState(originalState, true); axios.defaults.adapter = originalAxiosAdapter;
    vi.unstubAllGlobals(); });

type PreferenceKey = 'favoriteDirectories' | 'favoriteMachines' | 'favoriteBackendTargetKeysV1'
    | 'attachmentsUploadsWorkspaceRelativeDir' | 'newSessionDefaultPersistenceModeByTargetKeyV1'
    | 'connectedServicesQuotaPinnedMeterIdsByKey';
const externalAccount = { service: { pluginId: 'acme.provider.cloud', localId: 'compute' }, accountId: 'work' };
const externalAccountKey = connectedServiceProfileKey({ serviceId: 'acme.provider.cloud/compute', profileId: externalAccount.accountId });
const preferences: ReadonlyArray<Readonly<{ key: PreferenceKey; anchor: string; value: Settings[PreferenceKey] }>> = [
    { key: 'favoriteDirectories', anchor: 'session.favoriteDirectories', value: ['~/projects', 'C:\\code'] },
    { key: 'favoriteMachines', anchor: 'session.favoriteMachines', value: ['machine-work'] },
    { key: 'favoriteBackendTargetKeysV1', anchor: 'session.favoriteAgents', value: ['agent:acme.agent.review/review'] },
    { key: 'attachmentsUploadsWorkspaceRelativeDir', anchor: 'attachments.uploadsDirectory', value: '.happier/files' },
    { key: 'newSessionDefaultPersistenceModeByTargetKeyV1', anchor: 'permissions.agentStorage',
        value: { 'agent:acme.agent.review/review': 'direct' } },
    { key: 'connectedServicesQuotaPinnedMeterIdsByKey', anchor: 'connectedServices.pinnedUsageWindows',
        value: { [externalAccountKey]: ['daily', 'monthly'] } },
];

describe('Session preferences through the real Settings Action composition', () => {
    it.each(preferences)('admits $key under Off / Ask / Allowed and projects Agent writes to UI readers', async preference => {
        const baseline = settingsParse({ memoryUseInNewSessions: false, experiments: true,
            featureToggles: { 'sessions.direct': true, 'attachments.uploads': true } });
        const account = await createSecretSettingsTestHarness({ serverIdentityId: 'srv_session_preferences', settings: settingsParse({ ...baseline,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui', 'agent'] } } },
        }) });
        // Share one Home HTTP boundary between the actual CLI writer and UI's Account CAS reader.
        const adapter: AxiosAdapter = async config => {
            const response = await account.request(String(config.url), { method: config.method?.toUpperCase(),
                headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)])),
                ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }) });
            return { config, status: response.status, statusText: response.statusText,
                headers: Object.fromEntries(response.headers), data: await response.json() };
        };
        axios.defaults.adapter = adapter;
        vi.stubGlobal('fetch', account.request);
        const executor = createCliActionExecutorFromCredentials({
            credentials: { token: account.credentials.token, encryption: null, credentialProvenance: 'stored_session' },
            serverId: account.scope.serverId, serverIdentityId: 'srv_session_preferences',
            serverApiUrl: new URL(String(account.request.mock.calls[0]![0])).origin,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => account.persistedSettings }),
        });
        const probe = await renderHook(() => {
            const mutable = useSettingMutable(preference.key);
            const neighbor = useSettingMutable('memoryUseInNewSessions');
            const pins = useConnectedAccountPinnedMeters({ account: externalAccount, legacyServiceId: null });
            return { value: mutable[0], neighbor, pins, write: () => mutable[1](preference.value) };
        });
        const agentWrite = () => executor.execute('settings.set', { anchor: preference.anchor, value: preference.value }, {
            surface: 'agent', serverId: account.scope.serverId,
            authority: 'account_automation', actionCaller: { kind: 'host' }, actionRequestId: `preference-${preference.key}`,
        });
        try {
            await act(async () => { await probe.getCurrent().write(); });
            expect(account.settingsWrites).toEqual([]);
            expect(await agentWrite()).toMatchObject({ ok: false });
            expect(probe.getCurrent().value).toEqual(baseline[preference.key]);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { approvalRequiredSurfaces: ['ui', 'agent'] } } },
            })); });
            // A mounted UI control holds its value until the Inbox decision settles.
            let pending: ReturnType<ReturnType<typeof probe.getCurrent>['write']> | undefined;
            await act(async () => { pending = probe.getCurrent().write(); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(account.settingsWrites).toEqual([]);
            expect(probe.getCurrent().value).toEqual(baseline[preference.key]);
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await act(async () => { await pending; });
            expect(account.persistedSettings[preference.key]).toEqual(baseline[preference.key]);
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] } },
            })); });
            expect(await executor.execute('settings.list', { pageId: preference.anchor.split('.')[0] }, {
                surface: 'agent', serverId: account.scope.serverId,
                authority: 'account_automation', actionCaller: { kind: 'host' },
            })).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
                expect.objectContaining({ anchor: preference.anchor, readable: true, writable: true }),
            ]) } });
            // Agent dispatch uses the production executor, declaration, Account CAS and HTTP boundary.
            const minimumVersion = (storage.getState().settingsVersion ?? 0) + 1;
            await act(async () => {
                const agentResult = await agentWrite();
                expect(agentResult.ok ? 'ok' : agentResult.errorCode).toBe('ok');
                await sync.refreshAccountSettingsFromServer(minimumVersion, account.scope);
            });
            await vi.waitFor(() => expect(account.persistedSettings[preference.key]).toEqual(preference.value));
            expect(probe.getCurrent().value).toEqual(preference.value);
            if (preference.key === 'connectedServicesQuotaPinnedMeterIdsByKey') {
                expect(probe.getCurrent().pins.pinnedMeterIds).toEqual(['daily', 'monthly']);
            }
            await act(async () => { account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent'] } },
            })); });
            await act(async () => { await probe.getCurrent().write(); });
            await vi.waitFor(() => expect(account.persistedSettings[preference.key]).toEqual(preference.value));
            await act(async () => { probe.getCurrent().neighbor[1](true); });
            await vi.waitFor(() => expect(account.persistedSettings.memoryUseInNewSessions).toBe(true));
            expect(account.persistedSettings[preference.key]).toEqual(preference.value);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
