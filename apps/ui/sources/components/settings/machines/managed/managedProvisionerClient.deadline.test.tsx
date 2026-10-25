import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { upsertServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

installApprovalCommonModuleMocks();
const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');

afterEach(async () => {
    await standardCleanup();
    vi.useRealTimers();
    resetRuntimeFetch();
    vi.restoreAllMocks();
});

describe('managed catalog request lifetime', () => {
    it('counts Account preparation and daemon dispatch in one read deadline', async () => {
        const serverUrl = 'https://catalog-preparation.example.test';
        const homeId = 'srv_catalog_preparation';
        await upsertServerProfile({ serverUrl, name: 'Catalog Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, {
            token: createAccountTokenForTests('catalog-owner', { currentAccount: true }),
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        let preparationIssued!: () => void;
        const preparing = new Promise<void>(resolve => { preparationIssued = resolve; });
        let dispatchIssued!: () => void;
        const dispatched = new Promise<void>(resolve => { dispatchIssued = resolve; });
        let releasePreparation!: () => void;
        let requestSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') {
                const pending = new Promise<void>(resolve => { releasePreparation = resolve; });
                preparationIssued();
                await pending;
                return Response.json({ mode: 'plain', updatedAt: 1 });
            }
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path !== '/v1/actions/machines.provisioners.list') return Response.json({}, { status: 404 });
            requestSignal = init?.signal;
            dispatchIssued();
            return await new Promise<Response>((_resolve, reject) => {
                const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
                init?.signal?.addEventListener('abort', abort, { once: true });
                if (init?.signal?.aborted) abort();
            });
        });
        vi.useFakeTimers();
        const pending = createDefaultActionExecutor().execute('machines.provisioners.list',
            { homeId, controller: { machineId: 'controller', installationId: 'installation' } },
            { serverId: homeId, expectedAccountId: 'catalog-owner', surface: 'ui', authority: 'present_user', actionRequestId: 'preparation-read' });
        await preparing;
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2);
        releasePreparation();
        await dispatched;
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2 - 1);
        expect(requestSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(requestSignal?.aborted).toBe(true);
        expect(await pending).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    });

    it('settles a silent controller at the existing RPC deadline and retries through the same picker', async () => {
        const serverUrl = 'https://catalog-deadline.example.test';
        const homeId = 'srv_catalog_deadline';
        const token = createAccountTokenForTests('catalog-owner', { currentAccount: true });
        await upsertServerProfile({ serverUrl, name: 'Catalog Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [homeId]: [createMachineFixture({
            id: 'controller', installationId: 'installation', activeAt: Date.now(), kind: 'persistent',
        })] }, machineListStatusByServerId: { [homeId]: 'idle' } });
        let issued!: () => void;
        const dispatched = new Promise<void>(resolve => { issued = resolve; });
        let answer = false;
        let catalogSignal: AbortSignal | null | undefined;
        let reads = 0;
        // Only HTTP is substituted. The real Action, scope, catalog hook and request deadline run.
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path !== '/v1/actions/machines.provisioners.list') return Response.json({}, { status: 404 });
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            reads++;
            if (!answer) {
                catalogSignal = init?.signal;
                issued();
                return await new Promise<Response>((_resolve, reject) => {
                    const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
                    init?.signal?.addEventListener('abort', abort, { once: true });
                    if (init?.signal?.aborted) abort();
                });
            }
            return Response.json({ v: 1, actionId: 'machines.provisioners.list', requestId: envelope.requestId,
                execution: { ok: true, result: { provisioners: [] } } });
        });
        vi.useFakeTimers();
        const screen = await renderScreen(<ListPresentationProvider value="page">
            <MachineProvisionerPicker serverId={homeId} />
        </ListPresentationProvider>);
        await dispatched;
        await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS - 1); });
        expect(catalogSignal?.aborted).toBe(false);
        expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(catalogSignal?.aborted).toBe(true);
        expect(screen.findByTestId('managed-picker.unavailable-diagnostic-target_unavailable')).not.toBeNull();
        const retry = screen.findByTestId('managed-picker.unavailable-action');
        expect(retry).not.toBeNull();
        answer = true;
        await act(async () => { screen.pressByTestId('managed-picker.unavailable-action'); });
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(reads).toBe(2);
        expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
        await screen.unmount();
    });

    it('keeps valid near-deadline reads and caller-owned acquisition waits intact', async () => {
        const serverUrl = 'https://catalog-lifetime.example.test';
        const homeId = 'srv_catalog_lifetime';
        const token = createAccountTokenForTests('catalog-owner', { currentAccount: true });
        await upsertServerProfile({ serverUrl, name: 'Catalog Home' });
        await setServerProfileIdentityForUrl(serverUrl, homeId);
        await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: homeId }, { token });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { executeManagedMachineNativeAction } = await import('@/sync/api/machines/managedMachineOrigination');
        const account = await captureLazyActionAccountContext(homeId);
        let release!: () => void;
        let issued!: () => void;
        let requestSignal: AbortSignal | null | undefined;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/machines') return Response.json([ExternalActionMachineBootstrapV1Schema.parse({ id: 'controller', kind: 'persistent', active: true,
                installationId: 'installation', revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
                access: { custodian: { accountId: 'catalog-owner', displayName: 'Catalog owner' }, accessState: 'ready', role: 'manage', resourceMode: 'plain' } })]);
            // The controller row is read through the batched Machine reader.
            if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body, machineId => machineId === 'controller'
                ? { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'catalog-owner' }), installationId: 'installation' } : null);
            requestSignal = init?.signal;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const pending = new Promise<void>(resolve => { release = resolve; });
            issued();
            await pending;
            return Response.json({ v: 1, actionId: path.slice('/v1/actions/'.length), requestId: envelope.requestId,
                execution: { ok: true, result: path.endsWith('/machines.provisioners.list')
                    ? { provisioners: [] }
                    : { kind: 'approval_request_created', artifactId: 'native-approval', actionId: 'machines.managed.acquire' } } });
        });
        vi.useFakeTimers();
        try {
            for (const actionId of ['machines.provisioners.list', 'machines.managed.acquire'] as const) {
                const dispatched = new Promise<void>(resolve => { issued = resolve; });
                const pending = executeManagedMachineNativeAction({ account, actionId,
                    input: actionId === 'machines.provisioners.list'
                        ? { homeId, controller: { machineId: 'controller', installationId: 'installation' } }
                        : { selection: { kind: 'one-off', homeId, controller: { machineId: 'controller', installationId: 'installation' },
                            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
                            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
                    context: { surface: 'ui', authority: 'present_user', actionRequestId: actionId } });
                await Promise.race([dispatched, pending.then(result => {
                    throw new Error(`Action settled before dispatch: ${JSON.stringify(result)}`);
                })]);
                await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + (actionId === 'machines.provisioners.list' ? -1 : 1));
                expect(requestSignal?.aborted).toBe(false);
                release();
                expect(await pending).toMatchObject({ ok: true });
            }
        } finally { account.dispose(); }
    });
});
