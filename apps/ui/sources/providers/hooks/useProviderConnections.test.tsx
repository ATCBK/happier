import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderProbeObservationIdentityV1Schema } from '@happier-dev/protocol/providers/fingerprints';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createProviderConnectionsDescribeFixture,
    createProviderConnectionViewFixture,
    createProviderSettingsAccountHarness,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { applyProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);
providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => machineRpcWithServerScope(request));
const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';

// Install Home transport before the credential hook can load Sync's request graph.
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useProviderConnections } = await import('./useProviderConnections');
const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');

describe('useProviderConnections', () => {
    afterEach(async () => {
        standardCleanup();
        await account.reset();
    });
    beforeEach(async () => {
        providerHarness.reset();
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => machineRpcWithServerScope(request));
        machineRpcWithServerScope.mockReset();
        serverId = (await account.restore({ waivedActions: ['providers.connections.delete'],
            machines: ['machine-a', 'machine-b'].map(id => createMachineFixture({ id, active: true, activeAt: Date.now() })),
        })).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });

    it('withdraws the addressed catalog when its Home is missing instead of reading the active Home', async () => {
        let addressedServerId: string | null = serverId;
        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: null, serverId: addressedServerId,
        }));
        await vi.waitFor(() => expect(hook.getCurrent().data).not.toBeNull());
        addressedServerId = null;
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().data).toBeNull();
        expect(hook.getCurrent().catalog).toBeNull();
    });

    it('keeps saved editor configuration at the revision its Account describe read', async () => {
        let revision = 1;
        const catalogAt = (value: number) => ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: `Acme ${value}`, baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: `Acme ${value}`, displayNameMode: 'custom', revision: value, createdAt: 1, updatedAt: value }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalogAt(revision) } } }),
        });
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId, connectionId: 'pc_a' }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(1);
        revision = 2;
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        await act(async () => { applyProviderCatalogSnapshot(scope, { status: 'ready', catalog: catalogAt(2), revision: 2 }, true); });
        await hook.rerender();
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(1);
        expect(hook.getCurrent().data?.connections[0]?.revision).toBe(1);
        await act(async () => { await hook.getCurrent().refresh('account'); });
        expect(hook.getCurrent().catalog?.connections[0]?.revision).toBe(2);
        expect(hook.getCurrent().data?.connections[0]?.revision).toBe(2);
        await act(async () => { applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'encryption-material-unavailable' }, true); });
        expect(hook.getCurrent().catalog).toBeNull();
        expect(hook.getCurrent().data).toBeNull();
    });

    it('settles an unreadable Account credential without a machine and recovers on Retry', async () => {
        // The device credential store is the boundary; scope resolution and the
        // Provider Action/read lifecycle remain real.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const workingRead = credentialRead.getMockImplementation()!;
        credentialRead.mockRejectedValue(new Error('device credential store unavailable'));
        const hook = await renderHook(() => ({
            scope: useServerCredentialAccountScopeBinding(serverId),
            connections: useProviderConnections({ enabled: true, machineId: null, serverId }),
        }));
        await vi.waitFor(() => expect(hook.getCurrent().scope.resolution.kind).toBe('unavailable'));
        expect(hook.getCurrent().connections).toMatchObject({
            data: null, loading: false, error: { code: 'provider_authorization_changed', retryable: true },
        });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();

        credentialRead.mockImplementation(workingRead);
        await act(async () => { await hook.getCurrent().connections.refresh(); });
        await vi.waitFor(() => expect(hook.getCurrent().connections).toMatchObject({
            data: { status: 'success', connections: [] }, error: null, loading: false,
        }));
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('refreshes visible peers after a same-route mutation and refreshes hidden projections only when revealed', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        let connectionExists = true;
        account.home.answer(otherServerId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        account.home.answer(otherServerId, '/v1/account/encryption/currentness', {
            body: createPlainAccountEncryptionCurrentnessFixture(),
        });
        // Catalog CAS is the genuine Home boundary; deletion is an Account Action,
        // not a daemon mutation. Its subsequent census changes at the machine boundary.
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account catalog');
                catalog = mutation.content.v;
                revision += 1;
                connectionExists = catalog.connections.some(connection => connection.id === 'pc_a');
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        machineRpcWithServerScope.mockImplementation(async () => createProviderConnectionsDescribeFixture({
                connections: connectionExists ? [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] : [],
            }));
        const resolveTarget = () => ({ machineId: 'machine-a', serverId });
        const hook = await renderHook(({ visible }: { visible: boolean }) => {
            const list = useProviderConnections({ enabled: true, active: visible, ...resolveTarget() });
            const detail = useProviderConnections({ enabled: true, ...resolveTarget(), connectionId: 'pc_a' });
            const otherServer = useProviderConnections({ enabled: true, machineId: 'machine-a', serverId: otherServerId });
            const otherMachine = useProviderConnections({ enabled: true, machineId: 'machine-b', serverId });
            const refresh = React.useCallback(async (scope?: 'account' | 'machine') => { await detail.refresh(scope); }, [detail.refresh]);
            const mutation = useProviderConnectionMutation({ resolveTarget, refresh });
            return { list, detail, otherServer, otherMachine, mutation };
        }, { initialProps: { visible: true } });
        await vi.waitFor(() => {
            for (const projection of [hook.getCurrent().list, hook.getCurrent().detail,
                hook.getCurrent().otherServer, hook.getCurrent().otherMachine]) {
                expect(projection.loading).toBe(false);
                expect(projection.error).toBeNull();
                expect(projection.data?.connections).toHaveLength(1);
            }
        });
        machineRpcWithServerScope.mockClear();

        await act(async () => {
            await hook.getCurrent().mutation.run({ action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' });
        });
        expect(hook.getCurrent().detail.data?.connections).toHaveLength(0);
        expect(hook.getCurrent().list.data?.connections).toHaveLength(0);
        expect(hook.getCurrent().otherServer.data?.connections).toHaveLength(1);
        await vi.waitFor(() => expect(hook.getCurrent().otherMachine.data?.connections).toHaveLength(0));
        expect(machineRpcWithServerScope.mock.calls.map(([request]) => request)).toHaveLength(3);
        expect(machineRpcWithServerScope.mock.calls.every(([request]) => request.serverId === serverId)).toBe(true);
        expect(machineRpcWithServerScope.mock.calls.filter(([request]) => request.machineId === 'machine-b')).toHaveLength(1);

        await hook.rerender({ visible: false });
        connectionExists = true;
        machineRpcWithServerScope.mockClear();
        await act(async () => { await hook.getCurrent().detail.refresh(); });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
        expect(hook.getCurrent().list.data?.connections).toHaveLength(0);
        await hook.rerender({ visible: true });
        expect(hook.getCurrent().list.data?.connections).toHaveLength(1);
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
    });

    it('performs no Provider RPC when the canonical root feature decision is disabled', async () => {
        const hook = await renderHook(() => useProviderConnections({
            enabled: false,
            machineId: 'machine-a',
            serverId,
        }));

        expect(hook.getCurrent()).toMatchObject({ data: null, error: null, loading: false });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('keeps admitted Account rows on a remount while its fresh Home read is pending', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        const first = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await vi.waitFor(() => expect(first.getCurrent().data?.connections[0]?.displayName).toBe('Acme'));
        await first.unmount();
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            respondAfter: pending, body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        try {
            const second = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId, connectionId: 'pc_a' }));
            expect(second.getCurrent().data?.connections).toMatchObject([{ connectionId: 'pc_a', displayName: 'Acme' }]);
            expect(second.getCurrent().loading).toBe(false);
            expect(second.getCurrent().catalog?.connections[0]?.revision).toBe(1);
            await act(async () => { applyProviderCatalogSnapshot(captureActiveServerAccountScopeLifetime()!.scope,
                { status: 'unavailable', reason: 'encryption-material-unavailable' }, true); });
            expect(second.getCurrent().data).toBeNull();
        } finally { await act(async () => { release(); }); }
    });

    it('keeps answered Account rows available while Machine augmentation refreshes without refetching unchanged inputs', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        let finishRead!: (response: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        const initialMachineReply = createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Acme', displayNameMode: 'custom',
                probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse('probe-observation:v1:current-machine') })],
            discoveryCandidates: [{ v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/acme', providerName: 'Acme',
                endpointTemplateId: 'native', normalizedEndpointUrl: 'http://127.0.0.1:11434/',
                evidence: { kind: 'attributed_listener' }, ownership: 'adopted',
                connection: { status: 'matched', connectionId: ProviderConnectionIdSchema.parse('pc_a') } }],
            localInstallations: [{ v: 1, machineId: 'machine-a', contributionKey: 'acme.plugin/acme', providerName: 'Acme',
                status: 'installed_not_running', managedStartAvailable: true }],
        });
        initialMachineReply.discoveryCandidatesTruncated = true;
        initialMachineReply.localInstallationsStatus = 'incomplete';
        machineRpcWithServerScope.mockResolvedValueOnce(initialMachineReply);
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId }));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        const answered = hook.getCurrent().data;
        expect(answered).not.toBeNull();
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
        let refresh!: Promise<unknown>;
        await act(async () => {
            refresh = hook.getCurrent().refresh();
            await flushHookEffects();
        });
        try {
            await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
            expect(hook.getCurrent().data?.connections).toMatchObject([{ connectionId: 'pc_a', displayName: 'Acme' }]);
            expect(hook.getCurrent().data?.connections[0]).toBe(answered?.connections[0]);
            expect(hook.getCurrent().data?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:current-machine');
            expect(hook.getCurrent().data).toMatchObject({
                discoveryCandidates: initialMachineReply.discoveryCandidates, discoveryCandidatesTruncated: true,
                localInstallations: initialMachineReply.localInstallations, localInstallationsStatus: 'incomplete',
            });
            expect(hook.getCurrent().catalog?.connections).toMatchObject([{ id: 'pc_a', displayName: 'Acme' }]);
            expect(hook.getCurrent().loading).toBe(false);
            await hook.rerender();
            await hook.rerender();
            expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => {
                finishRead(createProviderConnectionsDescribeFixture({ connections: [] }));
                await refresh;
            });
        }
        expect(hook.getCurrent().data?.connections[0]?.probeObservationIdentity).toBeNull();
        expect(hook.getCurrent().data?.discoveryCandidates).toEqual([]);
        expect(hook.getCurrent().data?.localInstallations).toEqual([]);
    });

    it('replaces a reopened cached Machine answer with fresh Account facts while its new check is pending or refused', async () => {
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: ProviderConnectionsCatalogV1Schema.parse({
                ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
                }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision, createdAt: 1, updatedAt: revision }],
            }) } } }),
        });
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', revision: 1 }),
        ] }));
        const input = { enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' };
        const first = await renderHook(() => useProviderConnections(input));
        await waitForHomeGovernance(() => expect(first.getCurrent().loading).toBe(false));
        await first.unmount();
        revision = 2;
        let finish!: (response: unknown) => void;
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const reopened = await renderHook(() => useProviderConnections(input));
        try {
            await waitForHomeGovernance(() => expect(finish).toBeTypeOf('function'));
            expect(reopened.getCurrent().catalog?.connections[0]?.revision).toBe(2);
            expect(reopened.getCurrent().data?.connections[0]?.revision).toBe(2);
        } finally {
            await act(async () => finish?.({ status: 'error', error: createProviderErrorV1('agent_timeout', { machineId: 'machine-a' }) }));
        }
        await waitForHomeGovernance(() => expect(reopened.getCurrent().loading).toBe(false));
        expect(reopened.getCurrent().machineError?.code).toBe('agent_timeout');
        expect(reopened.getCurrent().data?.connections[0]?.revision).toBe(2);
    });

    it('publishes changed, added and deleted Account facts while retaining only equivalent Machine augmentation', async () => {
        const savedConnection = (id: string, revision: number) => ({
            v: 1, id, source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: id,
                baseUrl: id === 'pc_changed' && revision === 2 ? 'https://changed.example.test/v1' : 'https://models.example.test/v1',
                requiresApiKey: false,
            }) }, role: 'named', displayName: `${id} ${revision}`, displayNameMode: 'custom', revision, createdAt: 1, updatedAt: revision,
        });
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [savedConnection('pc_a', 1), savedConnection('pc_renamed', 1), savedConnection('pc_changed', 1),
                savedConnection('pc_deleted', 1), savedConnection('pc_grant', 1)],
            accountGrants: [{ v: 1, connectionId: 'pc_grant', connectionSecurityFingerprint: 'stale-account-grant', confirmedAt: 1 }],
        });
        let catalogRevision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } } }),
        });
        machineRpcWithServerScope.mockResolvedValue(createProviderConnectionsDescribeFixture({
            connections: catalog.connections.map(row => createProviderConnectionViewFixture({
                connectionId: row.id, revision: row.revision, displayName: row.displayName,
                probeObservationIdentity: ProviderProbeObservationIdentityV1Schema.parse(`probe-observation:v1:${row.id}`),
            })),
        }));
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.probeObservationIdentity).toBe('probe-observation:v1:pc_a'));
        catalog = ProviderConnectionsCatalogV1Schema.parse({ ...catalog,
            connections: [savedConnection('pc_a', 1), savedConnection('pc_renamed', 2), savedConnection('pc_changed', 2),
                savedConnection('pc_new', 1), savedConnection('pc_grant', 1)],
            accountGrants: [],
        });
        catalogRevision += 1;
        let finishRead!: (response: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
        let refresh!: Promise<unknown>;
        let refreshCompleted = false;
        await act(async () => { refresh = hook.getCurrent().refresh().finally(() => { refreshCompleted = true; }); });
        try {
            await waitForHomeGovernance(() => expect(typeof finishRead === 'function' || refreshCompleted).toBe(true));
            expect({ machineReadStarted: typeof finishRead === 'function', error: hook.getCurrent().error,
                machineError: hook.getCurrent().machineError }).toMatchObject({ machineReadStarted: true, error: null });
            expect(hook.getCurrent().data?.connections.map(row => ({
                connectionId: row.connectionId, revision: row.revision, probeObservationIdentity: row.probeObservationIdentity,
            }))).toEqual([
                { connectionId: 'pc_a', revision: 1, probeObservationIdentity: 'probe-observation:v1:pc_a' },
                { connectionId: 'pc_renamed', revision: 2, probeObservationIdentity: 'probe-observation:v1:pc_renamed' },
                { connectionId: 'pc_changed', revision: 2, probeObservationIdentity: null },
                { connectionId: 'pc_new', revision: 1, probeObservationIdentity: null },
                { connectionId: 'pc_grant', revision: 1, probeObservationIdentity: null },
            ]);
            expect(hook.getCurrent().data?.connections.find(row => row.connectionId === 'pc_renamed')?.displayName).toBe('pc_renamed 2');
            expect(hook.getCurrent().data?.connections.find(row => row.connectionId === 'pc_grant')?.grants.accountState).toBe('absent');
        } finally {
            await act(async () => {
                finishRead?.(createProviderConnectionsDescribeFixture({ connections: [] }));
                await refresh;
            });
        }
    });

    it('does not hold the selected query refresh open while a supporting pane is still reading', async () => {
        let holdCollection = false;
        let finishCollection!: (response: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        machineRpcWithServerScope.mockImplementation(async (request: { payload: { connectionId?: string } }) => {
            if (holdCollection && !request.payload.connectionId) {
                return await new Promise((resolve) => { finishCollection = resolve; });
            }
            return createProviderConnectionsDescribeFixture({ connections: [] });
        });
        const hook = await renderHook(() => {
            useProviderConnections({ enabled: true, machineId: 'machine-a', serverId });
            return useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' });
        });
        holdCollection = true;
        let completed = false;
        await act(async () => {
            void hook.getCurrent().refresh().then(() => { completed = true; });
            await flushHookEffects();
        });
        try {
            expect(completed).toBe(true);
        } finally {
            await act(async () => {
                finishCollection(createProviderConnectionsDescribeFixture({ connections: [] }));
            });
        }
    });

    it('clears machine A projection before awaiting machine B', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
        }));
        machineRpcWithServerScope.mockImplementationOnce(() => new Promise(() => undefined));
        const hook = await renderHook(
            ({ machineId }: { machineId: string }) => useProviderConnections({
                enabled: true, machineId, serverId,
            }),
            { initialProps: { machineId: 'machine-a' } },
        );
        await vi.waitFor(() => expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_a'));

        await hook.rerender({ machineId: 'machine-b' });
        expect(hook.getCurrent().data?.connections).toEqual([]);
    });

    it('never exposes a prior exact target during the render that changes machine, server, or connection', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }))
            .mockImplementation(() => new Promise(() => undefined));
        const observations: Array<Readonly<{
            scope: string;
            connectionId: string | null;
        }>> = [];
        function Harness(props: Readonly<{ machineId: string; serverId: string; connectionId: string }>) {
            const value = useProviderConnections({ enabled: true, ...props });
            observations.push({
                scope: `${props.serverId}/${props.machineId}/${props.connectionId}`,
                connectionId: value.data?.connections[0]?.connectionId ?? null,
            });
            return React.createElement('View');
        }
        const screen = await renderScreen(
            <Harness machineId="machine-a" serverId={serverId} connectionId="pc_a" />,
        );
        await vi.waitFor(() => expect(observations.at(-1)?.connectionId).toBe('pc_a'));

        for (const next of [
            { machineId: 'machine-b', serverId, connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: otherServerId, connectionId: 'pc_a' },
            { machineId: 'machine-b', serverId: otherServerId, connectionId: 'pc_b' },
        ]) {
            const scope = `${next.serverId}/${next.machineId}/${next.connectionId}`;
            await screen.update(<Harness {...next} />);
            expect(observations.some((entry) => (
                entry.scope === scope && entry.connectionId === 'pc_a'
            ))).toBe(false);
        }
    });

    it('clears Account A, rejects its late read, and starts one Account B read when routing ids stay equal', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        machineRpcWithServerScope
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const hook = await renderHook(() => useProviderConnections({
            enabled: true,
            machineId: 'machine-a',
            serverId,
        }));
        const refreshFromAccountA = hook.getCurrent().refresh;
        await vi.waitFor(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(1));

        await act(async () => {
            await account.restore({ accountId: 'account-b',
                machines: [createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })],
            });
            await hook.rerender();
        });

        // Account A must disappear synchronously; Account B's empty snapshot
        // arrives before its deferred Machine augmentation starts.
        expect(hook.getCurrent().data?.connections ?? []).toEqual([]);
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2));
        expect(hook.getCurrent().data?.connections).toEqual([]);

        await act(async () => {
            resolveA(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }));
        });
        expect(hook.getCurrent().data?.connections).toEqual([]);

        await act(async () => {
            resolveB(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_b' })],
            }));
        });
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_b');

        await act(async () => { await refreshFromAccountA(); });
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_b');
    });

    it('retains Account data without stale machine facts after an untyped refresh transport failure', async () => {
        machineRpcWithServerScope
            .mockResolvedValueOnce(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })],
            }))
            .mockRejectedValueOnce(new Error('offline'));
        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: 'machine-a', serverId,
        }));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({
            data: { connections: [] },
            error: null,
            machineError: createProviderErrorV1('machine_offline', {
                machineId: 'machine-a',
            }),
            loading: false,
        });
    });

    it('reports a successful transport with an invalid response as a contract failure, not an unreachable endpoint', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce(createProviderConnectionsDescribeFixture({ connections: [] }));
        providerHarness.transformAcknowledgement(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, (_request, acknowledgement) => ({
            ...acknowledgement,
            result: { ...createProviderConnectionsDescribeFixture({ connections: [] }), rawSecret: 'must-not-surface' },
        }));

        const hook = await renderHook(() => useProviderConnections({
            enabled: true, machineId: 'machine-a', serverId,
        }));

        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
            data: { connections: [] },
            error: null,
            machineError: {
                v: 1,
                code: 'provider_rpc_response_invalid',
                machineId: 'machine-a',
                retryable: true,
                action: 'retry',
            },
            loading: false,
        }));
        expect(hook.getCurrent().machineError?.code).not.toBe('provider_endpoint_unavailable');
    });
});
