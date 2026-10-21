import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readMachineRows } from './machineRowsApi';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { db } from '../../../../../server/sources/storage/db';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';

describe('selected Machine reads through the real Home admission owner', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-read-batch-', initAuth: true, initEncrypt: true });
    }, 180_000);
    afterAll(async () => { if (database) await database.close(); });

    it('gathers overlapping demands, isolates a departing reader, and re-admits settled rows and another Account', async () => {
        const owner = await db.account.create({ data: { publicKey: null, encryptionMode: 'e2ee' } });
        const foreign = await db.account.create({ data: { publicKey: null, encryptionMode: 'e2ee' } });
        const ids = Array.from({ length: 3 }, () => randomUUID());
        await db.machine.createMany({ data: ids.map((id, index) => ({ id, accountId: owner.id, metadata: 'opaque-encrypted-content',
            ...(index === 2 ? { kind: 'ephemeral_session_runner' as const } : {}) })) });
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        await app.ready();
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const censusEntered = createDeferred<void>();
        const censusRelease = createDeferred<void>();
        let gated = true;
        let gateCensus = false;
        let physicalSignal: AbortSignal | null | undefined;
        // Only HTTP/device storage are adapted. Both typed UI reads enter the
        // real route, snapshot, access opening, serialization and SQLite owners.
        const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://machine-read-batch.test',
            accountId: owner.id, accountMode: 'e2ee' }], route: async request => {
            if (request.path === '/v1/machines/read-batch' && gated) {
                physicalSignal = request.signal;
                entered.resolve();
                await release.promise;
            }
            if (request.path === '/v1/machines' && gateCensus) {
                censusEntered.resolve();
                await censusRelease.promise;
            }
            const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
                headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
                ...(request.body === undefined ? {} : { payload: request.body }) });
            return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
        } });
        const first = await captureLazyActionAccountContext(homes.homes.home!.id);
        const second = await captureLazyActionAccountContext(homes.homes.home!.id);
        const abort = new AbortController();
        const pending: Promise<unknown>[] = [];
        try {
            if (!first.readTransport || !second.readTransport) throw new Error('Captured Machine read transport unavailable');
            const leaving = readMachineRows({ readTransport: first.readTransport, machineIds: ids.slice(0, 2), signal: abort.signal });
            const stayed = readMachineRows({ readTransport: second.readTransport, machineIds: ids.slice(1) });
            pending.push(leaving, stayed);
            const abandoned = expect(leaving).rejects.toMatchObject({ name: 'AbortError' });
            await entered.promise;
            const requests = () => homes.requests.filter(request => request.path === '/v1/machines/read-batch');
            expect(requests().map(request => request.body)).toEqual([{ machineIds: ids }]);
            abort.abort();
            first.dispose();
            await abandoned;
            expect(physicalSignal?.aborted).toBe(false);
            gated = false;
            release.resolve();
            const admitted = await stayed;
            second.assertCurrent();
            expect([...admitted.values()].map(row => row?.id)).toEqual(ids.slice(1));
            expect(admitted.get(ids[2]!)?.kind).toBe('ephemeral_session_runner');
            await flushHookEffects();
            const beforeCensus = homes.requests.filter(request => request.path === '/v1/machines').length;
            gateCensus = true;
            const census = () => fetchMachineRows({ credentials: second.credentials, request: second.request,
                readTransport: second.readTransport });
            const ordinary = Promise.all([census(), census()]);
            pending.push(ordinary);
            await censusEntered.promise;
            const fresh = fetchMachineRows({ credentials: second.credentials, request: second.request,
                readTransport: second.readTransport, fresh: true });
            pending.push(fresh);
            await flushHookEffects();
            expect(homes.requests.filter(request => request.path === '/v1/machines').length - beforeCensus).toBe(2);
            gateCensus = false;
            censusRelease.resolve();
            for (const rows of [...await ordinary, await fresh]) {
                expect(rows.map(row => row.id).sort()).toEqual(ids.slice(0, 2).sort());
            }
            await db.machine.update({ where: { id: ids[1]! }, data: { metadata: 'new-key-context', metadataVersion: 2, revokedAt: new Date(1234) } });
            const refreshed = await readMachineRows({ readTransport: second.readTransport, machineIds: [ids[1]!] });
            expect(refreshed.get(ids[1]!)).toMatchObject({ metadataVersion: 2, revokedAt: 1234 });
            expect(requests()).toHaveLength(2);
            await homes.switchAccount('home', foreign.id);
            const next = await captureLazyActionAccountContext(homes.homes.home!.id);
            try {
                if (!next.readTransport) throw new Error('Replacement Account read transport unavailable');
                const refused = await readMachineRows({ readTransport: next.readTransport, machineIds: ids });
                expect([...refused.values()]).toEqual([null, null, null]);
                expect(requests()).toHaveLength(3);
                await db.machineAccountGrant.create({ data: { machineId: ids[0]!, accountId: foreign.id,
                    accessLevel: 'view', createdByAccountId: owner.id } });
                const pendingKey = await readMachineRows({ readTransport: next.readTransport, machineIds: [ids[0]!] });
                expect(pendingKey.get(ids[0]!)).toMatchObject({ metadata: null, daemonState: null, dataEncryptionKey: null,
                    access: { role: 'view', accessState: 'key_pending' } });
                await db.machineAccountGrant.deleteMany({ where: { machineId: ids[0]!, accountId: foreign.id } });
                const withdrawn = await readMachineRows({ readTransport: next.readTransport, machineIds: [ids[0]!] });
                expect(withdrawn.get(ids[0]!)).toBeNull();
                expect(requests()).toHaveLength(5);
            } finally { next.dispose(); }
            await flushHookEffects();
        } finally {
            release.resolve(); censusRelease.resolve(); await Promise.allSettled(pending);
            first.dispose(); second.dispose(); await homes.dispose(); await app.close();
        }
    });
});
