import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SavedSecretResourceMaterialV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { resetSavedSecretCatalogEngineForTests } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;

beforeEach(() => {
    resetSavedSecretCatalogEngineForTests();
    resetSavedSecretCatalogSnapshotsForTests();
    resetTeamActionClientForTests();
});
afterEach(async () => {
    standardCleanup();
    resetSavedSecretCatalogEngineForTests();
    await home?.dispose();
    home = null;
});

describe('useSavedSecretCatalog resource authority', () => {
    it('settles personal creation while the acknowledged material refresh is pending', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'secrets.shared.create': ['ui'] },
            }),
        }) });
        const { SharedSavedSecretCreateInputV1Schema } = await import('@happier-dev/protocol/account/settings/savedSecretResourceActionsV1');
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        const revalidation = createDeferred<void>();
        const request = home.request.getMockImplementation()!;
        let acknowledgedRef: string | null = null;
        home.request.mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/saved-secrets/resources' && init?.method === 'POST') {
                const created = SharedSavedSecretCreateInputV1Schema.parse(JSON.parse(String(init?.body)));
                acknowledgedRef = `happier:shared-secret:v1:${created.resourceId}`;
                return Response.json({ resourceId: created.resourceId, revision: 1 });
            }
            if (path === '/v1/account/saved-secrets/resources/materials' && acknowledgedRef !== null) await revalidation.promise;
            return request(input, init);
        });
        let settled = false;
        let operation!: Promise<string | null>;
        await act(async () => {
            operation = hook.getCurrent().personalMutations.create({ name: 'Acknowledged key', value: 'value' }).then(result => {
                settled = true;
                return result;
            });
        });
        try {
            await vi.waitFor(() => expect(acknowledgedRef).not.toBeNull());
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
            expect(hook.getCurrent().entries.find(row => row.ref === acknowledgedRef)).toMatchObject({ name: 'Acknowledged key' });
        } finally {
            await act(async () => { revalidation.resolve(); await operation; });
        }
    });

    it('settles personal rename while the acknowledged material refresh is pending', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'secrets.shared.update': ['ui'] },
            }),
        }) });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const { entry } = await home.addOwnerResource();
        const hook = await renderHook(() => useSavedSecretCatalog({ scope: home!.scope }));
        await act(async () => hook.getCurrent().reload());
        const secret = hook.getCurrent().usableSecrets.find(secret => secret.id === entry.ref);
        expect(secret).toBeDefined();
        if (!secret) throw new Error('Expected an admitted owner resource');
        const revalidation = createDeferred<void>();
        const request = home.request.getMockImplementation()!;
        home.request.mockImplementation(async (input, init) => {
            if (new URL(String(input)).pathname === '/v1/account/saved-secrets/resources/materials'
                && home!.updates.length > 0) await revalidation.promise;
            return request(input, init);
        });
        let settled = false;
        let operation!: Promise<boolean>;
        await act(async () => {
            operation = hook.getCurrent().personalMutations.rename(secret, 'Acknowledged name').then(result => {
                settled = true;
                return result;
            });
        });
        try {
            await vi.waitFor(() => expect(home!.updates).toHaveLength(1));
            await act(async () => { await Promise.resolve(); });
            expect(settled).toBe(true);
            expect(hook.getCurrent().entries.find(row => row.ref === entry.ref)).toMatchObject({ name: 'Acknowledged name', revision: entry.revision! + 1 });
        } finally {
            await act(async () => { revalidation.resolve(); await operation; });
        }
    });

    // Private creation, Teams-off selection and collision import are exercised
    // through real HTTP/Action owners in savedSecretResourceOperations.test.ts.
    it('fails an explicitly unavailable catalog closed without projecting legacy Settings values', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        // Match the app entry: restore the canonical Sync singleton before its consumers load.
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const scope = home.scope;
        const hook = await renderHook(() => useSavedSecretCatalog({ scope, sharedEnabled: false,
            personalSecrets: [{ id: 'legacy-personal', name: 'Legacy token', kind: 'token',
                encryptedValue: { _isSecretValue: true, value: 'legacy-value' }, createdAt: 1, updatedAt: 1 }],
        }));
        await hook.getCurrent().reload();

        expect(hook.getCurrent().usableSecrets).toEqual([]);
        expect(hook.getCurrent().personalSecrets).toEqual([]);
        expect(hook.getCurrent().personalMutationsAvailable).toBe(false);
        expect(hook.getCurrent().resolveReference('legacy-personal')).toMatchObject({ status: 'deleted', secret: null });
        expect(hook.getCurrent().resolveReference('happier:shared-secret:v1:resource-a')).toMatchObject({
            kind: 'shared_resource', status: 'temporarily_unavailable', secret: null, revision: null,
        });
        expect(await hook.getCurrent().personalMutations.create({ name: 'Token', value: 'value' })).toBeNull();
        expect(home.request.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials')).toBe(false);
    });

    it('keeps healthy material selectable beside a corrupt row and reconciles its owner repair', async () => {
        home = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'secrets.shared.delete': ['ui'] },
            }),
        }) });
        const { useSavedSecretCatalog } = await import('./useSavedSecretCatalog');
        const { entry } = await home.addOwnerResource();
        const corrupt = SavedSecretResourceMaterialV1Schema.parse({ entry: {
            materialStatus: 'resource_corrupt', relationship: 'owner',
            repair: { kind: 'delete_resource', resourceId: 'opaque-row-id', expectedRevision: -3 },
        } });
        if ('resourceId' in corrupt || corrupt.entry.relationship !== 'owner') throw new Error('Expected an owner repair fixture');
        const corruptEntry = corrupt.entry;
        home.resources.push(corrupt);
        const scope = home.scope;
        const hook = await renderHook(() => useSavedSecretCatalog({ scope }));
        await act(async () => hook.getCurrent().reload());
        await vi.waitFor(() => expect(hook.getCurrent().corruptEntries).toEqual([corruptEntry]));
        expect(hook.getCurrent().entries.map(row => row.ref)).toEqual([entry.ref]);
        expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]);

        await act(async () => expect(await hook.getCurrent().deleteCorruptResource(corruptEntry)).toEqual({ ok: true }));
        expect(home.deletes).toEqual([expect.objectContaining({
            resourceId: 'opaque-row-id', expectedRevision: -3,
            referenceCensus: expect.objectContaining({ notificationChannels: { revision: 'absent', resourceRefs: [] } }),
        })]);
        await vi.waitFor(() => expect(hook.getCurrent().corruptEntries).toEqual([]));
        expect(hook.getCurrent().usableSecrets.map(secret => secret.id)).toEqual([entry.ref]);
    });
});
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
