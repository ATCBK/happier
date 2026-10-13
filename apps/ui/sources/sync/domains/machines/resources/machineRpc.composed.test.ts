import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, expect, it } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MachineVitalsGetInputV1Schema, MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// HTTP/auth are the Home boundary; the Action, route, codec and Socket.IO path stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { fetchMachineVitalsViaMachineRpc } = await import('./machineRpc');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');

afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
});

it('reads a newly registered reachable machine through the Action and real Socket.IO route', async () => {
    await loadSyncSingletonForTests();
    let serverUrl = '';
    const http = createServer(async (request, response) => {
        // Transport readiness also reads the physical endpoint below the domain HTTP boundary.
        if (request.url === '/health' || request.url === '/v1/auth/ping') {
            response.setHeader('content-type', 'application/json');
            response.end('{}');
            return;
        }
        const answer = await homes.request(new URL(request.url ?? '/', serverUrl), {
            method: request.method,
            headers: request.headers.authorization ? { Authorization: request.headers.authorization } : {},
        });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(await answer.text());
    });
    const server = new Server(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback Home');
    serverUrl = `http://127.0.0.1:${address.port}`;
    const serverId = await homes.addHome({ name: 'New machine', serverUrl,
        accountId: 'owner', currentAccount: true });
    const machine = createPlainMachineRowFixture({ id: 'new-machine', accountId: 'owner' });
    homes.answer(serverId, '/v1/machines/new-machine', { body: { machine } });
    const snapshot = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting', sample: null,
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    const reads: unknown[] = [];
    server.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CALL, async (raw: unknown, acknowledge: (answer: unknown) => void) => {
            if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
                acknowledge({ ok: false, error: 'invalid_rpc_request' });
                return;
            }
            const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method);
            reads.push({ method: raw.method, input: MachineVitalsGetInputV1Schema.parse(request.params) });
            acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, snapshot, request.callId) });
        });
    });
    try {
        expect(await fetchMachineVitalsViaMachineRpc({ serverId, machineId: machine.id, view: 'summary' }))
            .toEqual({ ok: true, value: snapshot });
        expect(reads).toEqual([{ method: 'new-machine:machines.vitals.get', input: { serverId, machineId: machine.id, view: 'summary' } }]);
    } finally {
        await serverScopedRpcSocketPool.stopAll();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
