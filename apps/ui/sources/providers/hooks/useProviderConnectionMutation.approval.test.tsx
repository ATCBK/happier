import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const scopedAccount = createProviderSettingsAccountHarness();
const harness = scopedAccount.home;
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
// Only Socket transport is substituted; scoped Machine routing, Artifact writes and Inbox execution stay real.
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);
await loadSyncSingletonForTests();
const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');
const { mutateProviderConnection } = await import('@/providers/actions/client');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
const { useActionApprovalContinuation } = await import('@/components/approvals/useActionApprovalContinuation');
const { useServerCredentialAccountScopeResolution } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');

beforeEach(async () => {
    standardCleanup(); await scopedAccount.reset();
    providerHarness.reset(); navigation.spies.push.mockClear();
});
afterEach(async () => { standardCleanup(); await scopedAccount.reset(); });
function catalogFixture() {
    return ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
            role: 'named', displayName: 'Approval source', displayNameMode: 'custom',
            revision: 1, createdAt: 1, updatedAt: 1 }],
    });
}
async function restoreAccount(waivedActions?: readonly ['providers.connections.delete']) {
    return scopedAccount.restore({ catalog: catalogFixture(), waivedActions,
        machines: [createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })] });
}
describe('Provider mutation deferred approval', () => {
    it('never reads the original result Artifact through a replacement Account on the same Home', async () => {
        const { serverId } = await restoreAccount();
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const onExecuted = () => {};
        const hook = await renderHook(() => ({
            follower: useActionApprovalContinuation({ scopeKey: 'provider-original-account', serverId, onExecuted }),
            resolution: useServerCredentialAccountScopeResolution(serverId),
        }));
        const caller = new AbortController();
        let execution: Promise<void> | undefined;
        let settlement: unknown = 'pending';
        try {
            await act(async () => {
                execution = mutateProviderConnection({ serverId,
                    request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
                }, { scope: { serverId, accountId: 'account-a' }, signal: caller.signal,
                    onApprovalPending: hook.getCurrent().follower.requestApproval,
                }).then(value => { settlement = { value }; }, failure => { settlement = { failure }; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = harness.artifacts(serverId).list()[0]!.id;
            const path = `/v1/artifacts/${artifactId}`;
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).not.toHaveLength(0));
            const originalToken = harness.requestsFor(path)[0]!.token;
            expect(originalToken).toBeTruthy();
            expect(settlement).toBe('pending');
            // Account B does not own A's Artifact. Its server refuses it, but the original
            // mounted follower must not address that result through B's credential at all.
            harness.answer(serverId, path, { status: 404, body: { error: 'not_found' } });
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().resolution).toMatchObject({
                kind: 'bound', scope: { serverId, accountId: 'account-b' },
            }));
            await flushHookEffects();
            expect(harness.requestsFor(path).filter(request => request.token !== originalToken)).toEqual([]);
            expect(providerHarness.state.requests).toEqual([]);
            expect(caller.signal.aborted).toBe(false);
        } finally {
            await act(async () => { caller.abort(); await execution; });
        }
    });
    it('follows each queued result-bearing approval on its captured Home when two Homes share one mounted registrar', async () => {
        const { serverId: homeA } = await restoreAccount();
        const home = scopedAccount.home;
        const homeB = await scopedAccount.addHome({ name: 'Provider multi B', serverUrl: 'https://provider-multi-b.test', accountId: 'account-b', active: false });
        let peerCatalog = catalogFixture();
        let peerRevision = 1;
        let peerWrites = 0;
        home.answer(homeB, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision: peerRevision, content: { t: 'plain', v: peerCatalog } } }),
        });
        home.answer(homeB, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(peerRevision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain peer Account row');
                peerCatalog = mutation.content.v;
                peerRevision += 1;
                peerWrites += 1;
                return { body: { status: 'updated', revision: peerRevision, cursor: peerRevision } };
            },
        });
        await home.requireUiApproval(homeB, 'providers.connections.delete');
        // The real Sync Home and both live Account scopes stay on A; B has its own
        // persisted policy and may not publish its Artifact into A's projection.
        await home.requireUiApproval(homeA, 'providers.connections.delete');
        const onExecuted = () => {};
        const hook = await renderHook(() => useActionApprovalContinuation({
            scopeKey: 'provider-two-captured-homes', serverId: homeA, onExecuted,
        }));
        const caller = new AbortController();
        const settlements = new Map<string, unknown>();
        const executions: Promise<void>[] = [];
        try {
            const request = async (serverId: string, accountId: string) => {
                await act(async () => {
                    executions.push(mutateProviderConnection({ serverId,
                        request: { action: 'delete', machineId: 'machine-shared', connectionId: 'pc_a' },
                    }, { scope: { serverId, accountId }, signal: caller.signal,
                        onApprovalPending: hook.getCurrent().requestApproval,
                    }).then(value => { settlements.set(serverId, { value }); }, failure => { settlements.set(serverId, { failure }); }));
                });
                await waitForHomeGovernance(() => expect(home.artifacts(serverId).list()).toHaveLength(1));
            };
            await request(homeA, 'account-a');
            const artifactA = home.artifacts(homeA).list()[0]!.id;
            await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBe(artifactA));
            await request(homeB, 'account-b');
            const artifactB = home.artifacts(homeB).list()[0]!.id;
            expect(providerHarness.state.requests).toEqual([]);
            // The second result may settle durably before the first queue head.
            await expect(decideApprovalAsInbox(homeB, artifactB, 'approve')).resolves.toMatchObject({ ok: true });
            await expect(decideApprovalAsInbox(homeA, artifactA, 'approve')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(settlements.get(homeA)).toMatchObject({ value: { status: 'success', action: 'delete' } }));
            await waitForHomeGovernance(() => expect(home.requestsFor(`/v1/artifacts/${artifactB}`)).not.toHaveLength(0));
            // Assert the outward wrong-Home request before waiting for the result it cannot return.
            expect([...new Set(home.requestsFor(`/v1/artifacts/${artifactB}`).map(request => request.serverId))]).toEqual([homeB]);
            await waitForHomeGovernance(() => expect(settlements.size).toBe(2));
            expect(settlements.get(homeB)).toMatchObject({ value: { status: 'success', action: 'delete' } });
            expect(scopedAccount.readCatalogRow()).toMatchObject({ revision: 2, content: { t: 'plain', v: { connections: [] } } });
            expect(peerCatalog.connections).toEqual([]);
            expect(peerRevision).toBe(2);
            expect(scopedAccount.catalogMutations).toHaveLength(1);
            expect(peerWrites).toBe(1);
            expect(providerHarness.state.requests).toEqual([]);
        } finally {
            await act(async () => { caller.abort(); await Promise.all(executions); });
            await hook.unmount();
            await scopedAccount.reset();
        }
    });
    it('preserves an acknowledged direct mutation after the captured Account retires', async () => {
        const { serverId } = await restoreAccount(['providers.connections.delete']);
        let releaseResponse: () => void = () => {};
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        scopedAccount.interceptCatalogMutation(async (_input, next) => {
            const receipt = next();
            await responseGate;
            return receipt;
        });
        const capturedAccount = new AbortController();
        const settled = mutateProviderConnection({ serverId,
            request: { action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' },
        }, { scope: { serverId, accountId: 'account-a' }, signal: capturedAccount.signal,
            onApprovalPending: () => { throw new Error('The Account waived approval for this direct mutation'); },
        }).then(value => ({ value }), failure => ({ failure }));
        await waitForHomeGovernance(() => expect(scopedAccount.catalogMutations).toHaveLength(1));
        expect(scopedAccount.readCatalogRow()).toMatchObject({ revision: 2, content: { t: 'plain', v: { connections: [] } } });
        await harness.switchAccount(serverId, 'account-b');
        capturedAccount.abort();
        releaseResponse();
        await expect(settled).resolves.toMatchObject({ value: { status: 'success', action: 'delete', deletedConnectionId: 'pc_a' } });
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(scopedAccount.catalogMutations).toHaveLength(1);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('opens the existing approval route and consumes its typed terminal result without replaying the mutation', async () => {
        const { serverId } = await restoreAccount();
        await harness.requireUiApproval(serverId, 'providers.connections.delete');
        const refresh = vi.fn(async () => {});
        const resolveTarget = () => ({ serverId, machineId: 'machine-a' });
        const hook = await renderHook(() => ({ mutation: useProviderConnectionMutation({ resolveTarget, serverId, refresh }),
            client: useProviderActionClient(serverId) }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().client.ready).toBe(true));
        let execution: ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']> | undefined;
        await act(async () => {
            execution = hook.getCurrent().mutation.run({ action: 'delete', machineId: 'machine-a', connectionId: 'pc_a' });
        });
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = harness.artifacts(serverId).list()[0]!.id;
        expect(hook.getCurrent().mutation.error).toBeNull();
        expect(hook.getCurrent().mutation.isPending('delete:pc_a')).toBe(true);
        expect(providerHarness.state.requests).toEqual([]);
        expect(navigation.spies.push).toHaveBeenCalledWith(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(serverId)}`);
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { await expect(execution).resolves.toMatchObject({ status: 'success', action: 'delete' }); });
        expect(hook.getCurrent().mutation.error).toBeNull();
        expect(hook.getCurrent().mutation.isPending('delete:pc_a')).toBe(false);
        expect(scopedAccount.readCatalogRow()).toMatchObject({ revision: 2, content: { t: 'plain', v: { connections: [] } } });
        expect(scopedAccount.catalogMutations).toHaveLength(1);
        expect(providerHarness.state.requests).toEqual([]);
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('ends pending local interest on Account retirement even when the explicit caller signal stays live', async () => {
        const { serverId } = await restoreAccount();
        await harness.requireUiApproval(serverId, 'providers.models.load');
        const hook = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const caller = new AbortController();
        let settlement: unknown = 'pending';
        let execution: Promise<void> | undefined;
        try {
            await act(async () => {
                execution = hook.getCurrent().loadProviderModel({ serverId, machineId: 'machine-a', connectionId: 'pc_a',
                    modelId: 'model-a', signal: caller.signal,
                }).then(value => { settlement = { value }; }, failure => { settlement = { failure }; });
            });
            await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
            expect(settlement).toBe('pending');
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            await flushHookEffects();
            expect(settlement).toMatchObject({ failure: { code: 'action_account_scope_changed' } });
            expect(caller.signal.aborted).toBe(false);
            expect(providerHarness.state.requests).toEqual([]);
        } finally {
            // Dispose the test's explicit interest even when the missing lifetime merge fails.
            await act(async () => { caller.abort(); await execution; });
        }
    });
});
