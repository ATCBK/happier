import { createHash, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, createPlainSessionOwnerMetadataEnvelopeV1, encodePlainArtifactStoredContent,
    sealPublicShareDataKeyV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { db, initDbPostgres, getDbProviderFromEnv } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { acrossAccountCursorCommit, databaseLatch } from '@/testkit/postgresAccountCursorContention';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerStoredContentPublicShareRoutes } from '@/app/api/routes/share/registerStoredContentPublicShareRoutes';
import { setTeamPolicyInTx } from '@/app/teams/policy';
import { writeArtifactPublicShare, writeSessionPublicShare, deleteSessionPublicShare } from './storedContentPublicShare';

const authentication = createPresentUserSessionAccessAuthentication();
const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
type PublicShareMutationResult = Awaited<ReturnType<
    typeof deleteSessionPublicShare | typeof writeSessionPublicShare | typeof writeArtifactPublicShare
>>;

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Stored-content public-share PostgreSQL admission', () => {
    const accountIds: string[] = [], teamIds: string[] = [];
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        initDbPostgres();
        await db.$connect();
    });
    beforeEach(() => {
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN', 'preview.example.test');
        vi.stubEnv('HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'none');
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', '1');
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.artifact.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.team.deleteMany({ where: { id: { in: teamIds.splice(0) } } });
        await db.account.deleteMany({ where: { id: { in: accountIds.splice(0) } } });
    });
    afterAll(async () => { await db.$disconnect(); });

    async function owner(mode: 'plain' | 'e2ee' = 'plain') {
        const row = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        accountIds.push(row.id);
        return row;
    }
    async function session(accountId: string, primaryTeamId?: string) {
        return db.session.create({ data: { accountId, tag: randomUUID(), encryptionMode: 'plain',
            metadata: '{"v":1}', metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: {} })), primaryTeamId } });
    }
    async function artifact(accountId: string) {
        return db.artifact.create({ data: { id: randomUUID(), accountId, headerVersion: 1, bodyVersion: 1,
            header: bytes({ title: 'Shareable' }), body: bytes({ body: 'Public text' }),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
    }

    it.each(['session_write', 'session_delete', 'artifact_write', 'artifact_delete'] as const)('commits %s across a hot cursor without transaction recovery', async operation => {
        const account = await owner();
        const subject = operation.startsWith('session') ? await session(account.id) : await artifact(account.id);
        const where = operation.startsWith('session') ? { sessionId: subject.id } : { artifactId: subject.id };
        const share = operation.endsWith('delete') ? await db.publicSessionShare.create({ data: { ...where,
            createdByUserId: account.id, tokenHash: createHash('sha256').update(randomUUID()).digest() } }) : null;
        if (operation === 'artifact_delete') {
            await withAuthenticatedTestApp(registerStoredContentPublicShareRoutes, async app => {
                const result = await acrossAccountCursorCommit<LightMyRequestResponse>(account.id, () => app.inject({ method: 'DELETE',
                    url: `/v1/public-shares/${share!.id}`, headers: { 'x-test-user-id': account.id } }));
                expect(result.statusCode, result.body).toBe(200);
            });
        } else {
            const result = await acrossAccountCursorCommit<PublicShareMutationResult>(account.id, () => operation === 'session_delete'
                ? deleteSessionPublicShare({ userId: account.id, sessionId: subject.id, authentication })
                : operation === 'session_write'
                    ? writeSessionPublicShare({ userId: account.id, sessionId: subject.id, lookupId: randomUUID(), authentication })
                    : writeArtifactPublicShare({ userId: account.id, artifactId: subject.id, lookupId: randomUUID(), authentication }));
            expect(result).toMatchObject({ type: 'ok' });
        }
        expect(await db.publicSessionShare.count({ where })).toBe(operation.endsWith('delete') ? 0 : 1);
        expect(await db.accountChange.count({ where: { accountId: account.id,
            kind: operation.startsWith('session') ? 'share' : 'artifact', entityId: subject.id } })).toBe(1);
    });

    it('rechecks the canonical Team public-link policy after a concurrent policy commit', async () => {
        const account = await owner();
        const team = await db.team.create({ data: { name: randomUUID(), externalSharingPolicy: 'allowed' } });
        teamIds.push(team.id);
        await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'owner' } });
        const row = await session(account.id, team.id);
        const original = db.$transaction;
        let changed = false;
        // The policy writer and share writer remain real. Only their SQL
        // transport scheduling is interposed at terminal Account publication.
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (!changed && /Account.*FOR NO KEY UPDATE/s.test(query)) {
                        changed = true;
                        expect(await inTx(client => setTeamPolicyInTx(client, { actorAccountId: account.id,
                            teamId: team.id, externalSharingPolicy: 'disabled' }), { isolationLevel: 'ReadCommitted' }))
                            .toMatchObject({ ok: true });
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await writeSessionPublicShare({ userId: account.id, sessionId: row.id,
                lookupId: randomUUID(), authentication }))
                .toEqual({ type: 'external-sharing-error', error: 'session_access_external_sharing_disabled' });
            expect(changed).toBe(true);
            expect(await db.publicSessionShare.count({ where: { sessionId: row.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: account.id, kind: 'share', entityId: row.id } })).toBe(0);
        } finally { db.$transaction = original; }
    });

    it.each(['artifact', 'session'] as const)('retains the committed rotated %s key when a competing options write waits for its resource owner', async kind => {
        const account = await owner('e2ee');
        const key = new Uint8Array(32).fill(17);
        const content = new Uint8Array(await sealSessionDataKeyBundleV0({ body: 'Private text' }, key));
        const row = kind === 'artifact'
            ? await db.artifact.create({ data: { id: randomUUID(), accountId: account.id, headerVersion: 1, bodyVersion: 1,
                header: content, body: content, dataEncryptionKey: new Uint8Array([31]) } })
            : await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'e2ee',
                metadata: privacyKit.encodeBase64(content), metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({ t: 'encrypted', c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==' }) } });
        const subjectWhere = kind === 'artifact' ? { artifactId: row.id } : { sessionId: row.id };
        const write = (material: { lookupId?: string; encryptedDataKey?: string; networkOff?: boolean }) => kind === 'artifact'
            ? writeArtifactPublicShare({ userId: account.id, artifactId: row.id, authentication, ...material })
            : writeSessionPublicShare({ userId: account.id, sessionId: row.id, authentication, ...material });
        const envelope = (secret: string, fill: number) => sealPublicShareDataKeyV1({ dataKey: key, secret,
            randomBytes: length => new Uint8Array(length).fill(fill) });
        const initial = await db.publicSessionShare.create({ data: { ...subjectWhere, createdByUserId: account.id,
            tokenHash: createHash('sha256').update(randomUUID()).digest(), keyDerivation: 'fragment_v1',
            encryptedDataKey: privacyKit.decodeBase64(envelope('old-secret', 3)), useCount: 7 } });
        const nextLookup = randomUUID(), nextKey = envelope('new-secret', 4);
        const read = databaseLatch(), resume = databaseLatch();
        const original = db.$transaction;
        let firstPid = 0, paused = false;
        db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                firstPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'publicSessionShare') return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.publicSessionShare, { get(model, method, modelReceiver) {
                        if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                        return async (...queryArgs: Parameters<typeof model.findUnique>) => {
                            const result = await model.findUnique(...queryArgs);
                            if (!paused && (kind === 'artifact' ? queryArgs[0].where.artifactId : queryArgs[0].where.sessionId) === row.id) {
                                paused = true;
                                read.release();
                                await resume.promise;
                            }
                            return result;
                        };
                    } });
                } }));
            }, ...args.slice(1)]);
        } });
        const rotation = write({ lookupId: nextLookup, encryptedDataKey: nextKey });
        const rotating = Promise.allSettled([rotation]);
        let updating: Promise<PromiseSettledResult<Awaited<ReturnType<typeof write>>>[]> | undefined;
        try {
            await Promise.race([read.promise, rotation.then(() => { throw new Error('Rotation bypassed share read'); })]);
            db.$transaction = original;
            updating = Promise.allSettled([write({ networkOff: true })]);
            await expect.poll(async () => {
                const blocked = await db.$queryRawUnsafe<Array<{ query: string }>>(
                    'SELECT query FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))', firstPid,
                );
                const resource = kind === 'artifact' ? 'Artifact' : 'Session';
                return blocked.some(result => result.query.includes(`FROM "${resource}"`) && result.query.includes('FOR NO KEY UPDATE'));
            }).toBe(true);
            resume.release();
            for (const result of [...await rotating, ...await updating]) {
                if (result.status === 'rejected') throw result.reason;
                expect(result.value).toMatchObject({ type: 'ok' });
            }
            const stored = await db.publicSessionShare.findUniqueOrThrow({ where: { id: initial.id } });
            expect(stored).toMatchObject({ networkOff: true, useCount: 0 });
            expect(stored.encryptedDataKey).toEqual(privacyKit.decodeBase64(nextKey));
            expect(stored.tokenHash).toEqual(new Uint8Array(createHash('sha256').update(nextLookup).digest()));
        } finally {
            db.$transaction = original;
            resume.release();
            await rotating;
            await updating;
        }
    });
});
