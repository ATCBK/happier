import { afterEach, describe, expect, it } from 'vitest';
import { createDeferred, createMachineFixture, flushHookEffects } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { machineWorkerPolicyGet } from '@/sync/ops/machineFinitePolicy';
import { resetScopedMachineTransportCacheForTests, resolveScopedMachineTransport } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';

// The real Sync/Account/transport graph is prepared outside a timed test.
await loadSyncSingletonForTests();
afterEach(() => resetScopedMachineTransportCacheForTests());

describe('Machine rows through captured Home readers', () => {
    it('shares a pending exact row between active finite-policy and scoped transport readers, but re-reads after settlement', async () => {
        const token = createAccountTokenForTests('machine-row-account');
        const row = createPlainMachineRowFixture({ id: 'machine-row', accountId: 'machine-row-account' });
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const home = await serveAccountHomes({ homes: [{ key: 'resource', serverUrl: 'https://machine-row-read.test',
            accountId: 'machine-row-account', accountMode: 'plain', credentials: { token } }],
            route: async request => {
                if (request.path === '/v1/machines') return Response.json([row]);
                if (request.path !== '/v1/machines/machine-row' && request.path !== '/v1/machines/read-batch') return undefined;
                entered.resolve();
                await release.promise;
                return request.path === '/v1/machines/read-batch'
                    ? Response.json({ results: [{ machineId: row.id, status: 'found', machine: row }] })
                    : Response.json({ machine: row });
            } });
        const { storage } = await import('@/sync/domains/state/storage');
        await flushHookEffects({ cycles: 12, turns: 2 });
        storage.getState().applyMachines([createMachineFixture({ id: row.id, storageMode: 'plain', access: row.access,
            dataEncryptionKey: row.dataEncryptionKey })], false, { sourceServerId: home.homes.resource!.id });
        const context = await resolveServerScopedContext({ serverId: home.homes.resource!.id,
            machineId: row.id, forceScoped: true });
        if (context.scope !== 'scoped') throw new Error('Expected captured scoped Machine authority');
        const scope = { serverId: context.targetServerId, serverUrl: context.targetServerUrl,
            token: context.token, machineId: row.id, accountId: context.targetAccountId,
            readTransport: context.readTransport, expectedAccountMode: 'plain' as const };
        const policy = machineWorkerPolicyGet(row.id);
        const transport = resolveScopedMachineTransport(scope);
        const outcomes = Promise.all([policy, transport]);
        try {
            await entered.promise;
            await flushHookEffects({ cycles: 12, turns: 2 });
            const exactReads = () => home.requests.filter(request => request.path === '/v1/machines/machine-row' || request.path === '/v1/machines/read-batch');
            expect.soft(exactReads()).toHaveLength(1);
            release.resolve();
            expect(await outcomes).toMatchObject([{ status: 'ready' }, { mode: 'plain' }]);
            await resolveScopedMachineTransport(scope);
            expect(exactReads()).toHaveLength(2);
        } finally {
            release.resolve();
            await outcomes.catch(() => {});
            await context.release?.();
            await home.dispose();
        }
    });
});
