import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1,
    projectSessionSharedMetadataV1, SessionMetadataOwnerPatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { writeSessionCapabilitySelectionToMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
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
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
    });
    afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

    it.each(['released', 'exhausted'] as const)('preserves the canonical metadata outcome when Account contention is %s', async contention => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const metadata = { path: '/tmp', host: 'session-capability-fixture' };
        const current = createSessionOwnerMetadataV1({ metadata });
        const next = createSessionOwnerMetadataV1({ metadata: writeSessionCapabilitySelectionToMetadataV1(metadata, {
            mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['owned-mcp'], forceExcludeServerIds: [] },
        }, { sessionActive: true }) });
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
        const peer = Reflect.apply(transaction, db, [async (tx: Tx) => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            locked();
            await releasePromise;
        }]) as Promise<unknown>;
        await lockedPromise;
        let attempts = 0;
        // Schedule only the real DB boundary. The real SQL lock failure still
        // traverses inTx, the tuple writer, HTTP handler and global error owner.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                attempts++;
                if (contention === 'exhausted') await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '50ms'");
                return callback(tx);
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerSessionPatchRoute, async app => {
                const responsePromise = app.inject({ method: 'PATCH', url: `/v2/sessions/${session.id}`,
                    headers: { 'x-test-user-id': account.id,
                        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) }, payload });
                if (contention === 'released') {
                    let settled = false;
                    void responsePromise.then(() => { settled = true; });
                    let observedWait = false;
                    while (!settled) {
                        const [{ waiting }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                AND wait_event_type = 'Lock' AND query LIKE '%"Account"%') AS waiting`,
                        );
                        if (waiting) { observedWait = true; break; }
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
