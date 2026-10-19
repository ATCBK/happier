import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1, SessionMetadataOwnerPatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import { writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session capability metadata transaction admission', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run against the lane-owned disposable PostgreSQL database');
        }
        initDbPostgres();
        await db.$connect();
    });
    beforeEach(() => { vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0'); });
    afterEach(() => { vi.unstubAllEnvs(); });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['released', 'exhausted', 'released-after-discovery'] as const)('preserves the canonical metadata outcome when Account contention is %s', async contention => {
        if (contention === 'released-after-discovery') vi.stubEnv('HAPPIER_DB_TX_TIMEOUT_MS', '2000');
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const metadata = { path: '/tmp', host: 'session-capability-fixture' };
        const current = createSessionOwnerMetadataV1({ metadata });
        const nextMetadata = contention === 'released-after-discovery'
            ? writeSessionExplicitStopV1ToMetadata(metadata, { v: 1, cause: 'explicit_stop', requestId: randomUUID(), requestedAtMs: Date.now() })
            : writeSessionCapabilitySelectionToMetadataV1(metadata, {
                mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['owned-mcp'], forceExcludeServerIds: [] },
            }, { sessionActive: true });
        const next = createSessionOwnerMetadataV1({ metadata: nextMetadata });
        if (!current.ok || !next.ok) throw new Error('Invalid canonical owner fixture');
        const expectedOwnerMetadata = createPlainSessionOwnerMetadataEnvelopeV1(current.ownerMetadata);
        const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1(next.ownerMetadata);
        const sharedMetadata = JSON.stringify(projectSessionSharedMetadataV1({ metadata }));
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: sharedMetadata,
            ownerMetadata: JSON.stringify(expectedOwnerMetadata), agentState: null,
        } });
        const payload = SessionMetadataOwnerPatchV1Schema.parse({ mode: 'owner', metadataLayoutVersion: 1,
            expectedOwnerMetadata, ownerMetadata,
            sharedMetadata: { ciphertext: sharedMetadata, expectedVersion: session.metadataVersion },
            agentState: { ciphertext: null, expectedVersion: session.agentStateVersion },
        });
        const transaction = db.$transaction;
        let release!: () => void;
        let locked!: () => void;
        const releasePromise = new Promise<void>(resolve => { release = resolve; });
        const lockedPromise = new Promise<void>(resolve => { locked = resolve; });
        let peerBackendPid = 0;
        const peer = Reflect.apply(transaction, db, [async (tx: Tx) => {
            const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            peerBackendPid = backend.pid;
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            locked();
            await releasePromise;
        }]) as Promise<unknown>;
        await lockedPromise;
        let attempts = 0;
        let discoveryDelayed = false;
        // Schedule only the real DB boundary. The real SQL lock failure still
        // traverses inTx, the tuple writer, HTTP handler and global error owner.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const options = args[1];
                const readSnapshot = options !== null && typeof options === 'object'
                    && 'isolationLevel' in options && options.isolationLevel === 'RepeatableRead';
                if (!readSnapshot) attempts++;
                if (contention === 'exhausted') await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '50ms'");
                // Schedule only the first real audience-discovery query at the
                // DB boundary. Discovery and the subsequent Account lock wait
                // each fit the configured execution budget, but their sum does
                // not. The actual PostgreSQL/Prisma rollback remains real.
                return callback(contention !== 'released-after-discovery' ? tx : new Proxy(tx, {
                    get(inner, property, innerReceiver) {
                        if (property !== 'sessionFollowEdge') return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.sessionFollowEdge, { get(model, method, modelReceiver) {
                            if (method !== 'findMany') return Reflect.get(model, method, modelReceiver);
                            return async (...queryArgs: unknown[]) => {
                                if (!discoveryDelayed) {
                                    discoveryDelayed = true;
                                    await inner.$queryRawUnsafe('SELECT 1::int FROM pg_sleep(1.2)');
                                }
                                return Reflect.apply(model.findMany, model, queryArgs);
                            };
                        } });
                    },
                }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerSessionPatchRoute, async app => {
                const responsePromise = app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`,
                    headers: { 'x-test-user-id': account.id,
                        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) }, payload });
                if (contention !== 'exhausted') {
                    let settled = false;
                    void responsePromise.then(() => { settled = true; });
                    let observedWait = false;
                    while (!settled) {
                        const [{ waiting }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                AND wait_event_type = 'Lock' AND query LIKE '%"Account"%'
                                AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`, peerBackendPid,
                        );
                        if (waiting) { observedWait = true; break; }
                    }
                    if (contention === 'released-after-discovery' && observedWait) {
                        await db.$queryRawUnsafe('SELECT 1::int FROM pg_sleep(1.2)');
                    }
                    release();
                    await peer;
                    expect(observedWait).toBe(true);
                }
                const response = await responsePromise;
                const stored = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                if (contention === 'exhausted') {
                    expect(stored.metadataVersion).toBe(session.metadataVersion);
                    expect(stored.ownerMetadata).toBe(JSON.stringify(expectedOwnerMetadata));
                    expect(response.statusCode).toBe(503);
                    expect(readHomeDomainConfirmedRollbackV1(response.statusCode, response.json())?.code)
                        .toBe('database_transaction_conflict_exhausted');
                } else {
                    expect(response.statusCode).toBe(200);
                    expect(SessionMetadataTuplePatchSuccessV1Schema.parse(response.json())).toMatchObject({ success: true });
                    expect(stored.metadataVersion).toBe(session.metadataVersion + 1);
                    expect(JSON.parse(stored.ownerMetadata!)).toEqual(ownerMetadata);
                }
                expect(attempts).toBe(1);
            });
        } finally {
            release();
            db.$transaction = transaction;
            await peer;
        }
    });
});
