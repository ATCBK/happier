// Match the mounted settings consumer's import order, avoiding a cold owner/catalog cycle.
import '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import axios, { type AxiosAdapter } from 'axios';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { resolveUiClientEncryptionRequirement } from '@/sync/domains/settings/clientEncryptionRequirement';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
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
const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const originalState = storage.getState();
const originalAxiosAdapter = axios.defaults.adapter;
afterEach(() => { standardCleanup(); storage.setState(originalState, true); axios.defaults.adapter = originalAxiosAdapter;
    vi.unstubAllGlobals(); });

const anchor = 'account.requireE2ee';
const features = () => createRootLayoutFeaturesResponse({ features: { encryption: { accountOptOut: { enabled: true } } },
    capabilities: { serverIdentity: { serverIdentityId: 'srv_client_encryption_requirement' } } });
const allowed = { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui', 'agent', 'mcp'] } };
const effective = () => resolveUiClientEncryptionRequirement({ syncedSettings: storage.getState().settings,
    localSettings: storage.getState().settings });

describe('client encryption requirement through the Settings Action', () => {
    it('applies the declared UI intent under Off / Ask rejected / Ask approved / Allowed', async () => {
        const account = await createSecretSettingsTestHarness({ mode: 'e2ee', serverIdentityId: 'srv_client_encryption_requirement', features: features(), settings: settingsParse({
            memoryUseInNewSessions: true,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        const probe = await renderHook(() => useSettingActionWriter());
        try {
            await act(async () => { expect(await probe.getCurrent()({ anchor }, true)).toMatchObject({ ok: false }); });
            expect(account.settingsWrites).toEqual([]);
            expect(effective()).toBe('follow_account');
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
                actions: { 'settings.set': { approvalRequiredSurfaces: ['ui'] } } } })); });
            let pending: ReturnType<ReturnType<typeof probe.getCurrent>> | undefined;
            await act(async () => { pending = probe.getCurrent()({ anchor }, true); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            expect(effective()).toBe('follow_account');
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[0]!.id, 'reject');
            await act(async () => { await pending; });
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { pending = probe.getCurrent()({ anchor }, true); });
            await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(2));
            await decideApprovalAsInbox(account.scope.serverId, account.artifacts.list()[1]!.id, 'approve');
            await act(async () => { await pending; });
            expect(account.persistedSettings.clientEncryptionRequirementV1).toBe('require_e2ee');
            expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('require_e2ee');
            expect(account.persistedRawSettings).not.toHaveProperty('clientEncryptionRequirementLocalV1');
            await act(async () => { account.replaceSettings(settingsParse({ ...storage.getState().settings, actionsSettingsV1: allowed })); });
            await act(async () => { expect(await probe.getCurrent()({ anchor }, false)).toMatchObject({ ok: true }); });
            expect(effective()).toBe('follow_account');
            await act(async () => { expect(await probe.getCurrent()({ anchor: 'prompts.context.memoryUseInNewSessions' }, true)).toMatchObject({ ok: true }); });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(true);
        } finally { await probe.unmount(); await account.dispose(); }
    });

    it.each([false, true])('retains the local minimum after a rejected upload (already required: %s), then recovers', async required => {
        const account = await createSecretSettingsTestHarness({ mode: 'e2ee', serverIdentityId: 'srv_client_encryption_requirement', features: features(), rejectSettingsWrites: true,
            settings: settingsParse({ actionsSettingsV1: allowed,
                clientEncryptionRequirementV1: required ? 'require_e2ee' : 'follow_account',
                clientEncryptionRequirementLocalV1: required ? 'require_e2ee' : 'follow_account' }) });
        const probe = await renderHook(() => useSettingActionWriter());
        try {
            await act(async () => { expect(await probe.getCurrent()({ anchor }, !required)).toMatchObject({ ok: false }); });
            expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('require_e2ee');
            expect(account.persistedSettings.clientEncryptionRequirementV1).toBe(required ? 'require_e2ee' : 'follow_account');
            account.setRejectSettingsWrites(false);
            await act(async () => { expect(await probe.getCurrent()({ anchor }, !required)).toMatchObject({ ok: true }); });
            expect(effective()).toBe(required ? 'follow_account' : 'require_e2ee');
        } finally { await probe.unmount(); await account.dispose(); }
    });

    it('refuses enabling on a Plain Account before pinning or uploading', async () => {
        const account = await createSecretSettingsTestHarness({ serverIdentityId: 'srv_client_encryption_requirement', features: features(), settings: settingsParse({ actionsSettingsV1: allowed }) });
        const probe = await renderHook(() => useSettingActionWriter());
        try {
            await act(async () => { expect(await probe.getCurrent()({ anchor }, true)).toMatchObject({ ok: false,
                errorCode: 'client_encryption_requirement_needs_e2ee' }); });
            expect(account.settingsWrites).toEqual([]);
            expect(effective()).toBe('follow_account');
        } finally { await probe.unmount(); await account.dispose(); }
    });

    it('keeps a strengthening pin before upload and never publishes into a replacement Account scope', async () => {
        const account = await createSecretSettingsTestHarness({ mode: 'e2ee', serverIdentityId: 'srv_client_encryption_requirement', features: features(),
            settings: settingsParse({ actionsSettingsV1: allowed }) });
        const upload = createDeferred<void>();
        const reachedUpload = createDeferred<void>();
        const originalRequest = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (url, init) => {
            if (new URL(String(url)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('require_e2ee');
                reachedUpload.resolve();
                await upload.promise;
            }
            return originalRequest(url, init);
        });
        const probe = await renderHook(() => useSettingActionWriter());
        let pending: ReturnType<ReturnType<typeof probe.getCurrent>> | undefined;
        try {
            await act(async () => { pending = probe.getCurrent()({ anchor }, true); });
            await reachedUpload.promise;
            await act(async () => { storage.setState({ settingsScope: { ...account.scope, accountId: 'replacement' },
                settings: settingsParse({ actionsSettingsV1: allowed }) }); });
            upload.resolve();
            await act(async () => { await pending; });
            expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('follow_account');
            expect(effective()).toBe('follow_account');
        } finally { upload.resolve(); await pending; await probe.unmount(); await account.dispose(); }
    });

    it.each(['agent', 'mcp'] as const)('uses the same pin transition through actual CLI reverse dispatch on %s', async surface => {
        const account = await createSecretSettingsTestHarness({ mode: 'e2ee', serverIdentityId: 'srv_client_encryption_requirement', features: features(),
            settings: settingsParse({ actionsSettingsV1: allowed }) });
        const receive = createUiClientActionReverseHandler({ ...account.scope, isCurrent: () => true });
        const adapter: AxiosAdapter = async config => {
            const response = await account.request(String(config.url), { method: config.method?.toUpperCase(),
                headers: Object.fromEntries(Object.entries(config.headers.toJSON()).map(([key, value]) => [key, String(value)])),
                ...(config.data === undefined ? {} : { body: typeof config.data === 'string' ? config.data : JSON.stringify(config.data) }) });
            return { config, status: response.status, statusText: response.statusText,
                headers: Object.fromEntries(response.headers), data: await response.json() };
        };
        axios.defaults.adapter = adapter;
        vi.stubGlobal('fetch', account.request);
        let connected = true;
        let dispatches = 0;
        const executor = createCliActionExecutorFromCredentials({ credentials: { ...account.credentials,
            credentialProvenance: 'stored_session' }, serverId: account.scope.serverId,
            serverIdentityId: 'srv_client_encryption_requirement',
            serverApiUrl: new URL(String(account.request.mock.calls[0]![0])).origin,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => account.persistedSettings }),
            clientActionExecute: createClientActionReverseDispatcher(() => ({
                hasConnectedClientRpcHandler: () => connected,
                callConnectedClientRpc: async (_method, payload, options) => {
                    // The server selects the receiver; a withdrawn App is typed absence before any client executes.
                    if (!connected) return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
                    dispatches++;
                    options.onIssued();
                    return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
                },
            })),
        });
        const context = { surface, authority: 'account_automation', serverId: account.scope.serverId,
            actionCaller: { kind: 'host' }, actionRequestId: `client-encryption-requirement-${surface}` } as const;
        try {
            await act(async () => {
                const result = await executor.execute('settings.set', { anchor, value: true }, context);
                expect(result.ok ? 'ok' : `${result.errorCode}:dispatches=${dispatches}`).toBe('ok');
            });
            expect(effective()).toBe('require_e2ee');
            expect(storage.getState().settings.clientEncryptionRequirementLocalV1).toBe('require_e2ee');
            await act(async () => {
                const result = await executor.execute('settings.set', { anchor, value: false }, context);
                expect(result.ok ? 'ok' : result.errorCode).toBe('ok');
            });
            expect(effective()).toBe('follow_account');
            expect(account.persistedRawSettings).not.toHaveProperty('clientEncryptionRequirementLocalV1');
            connected = false;
            const writes = account.settingsWrites.length;
            expect(await executor.execute('settings.set', { anchor, value: true }, context)).toMatchObject({ ok: false,
                details: { reason: 'client_unavailable' } });
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { await account.dispose(); }
    });
});
