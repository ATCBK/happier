import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { applyPostgresMigrations } from '../../../scripts/prismaMigrations';
import { openPgliteMigrationSession, type PgliteMigrationSession } from '../../../scripts/pgliteMigrationSession';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { applyEnvValues, restoreEnv, snapshotEnv } from '@/testkit/env';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';

describe('Artifact inventory through PostgreSQL wire protocol', () => {
    const originalEnv = snapshotEnv();
    let root: string | undefined;
    let session: PgliteMigrationSession | undefined;
    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-artifact-inventory-pg-'));
        const databaseDir = join(root, 'pglite');
        const database = new PGlite(databaseDir);
        try {
            await database.waitReady;
            await applyPostgresMigrations({ db: database, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        } finally { await database.close(); }
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DB_DIR: databaseDir, HAPPIER_SERVER_LIGHT_DATA_DIR: root });
        session = await openPgliteMigrationSession(process.env, { purpose: 'artifact-inventory-test' });
        // Use the deployed PostgreSQL Prisma client/query strategy, not the PGlite adapter.
        applyEnvValues({ HAPPIER_DB_PROVIDER: 'postgres', HAPPY_DB_PROVIDER: 'postgres', DATABASE_URL: session.databaseUrl });
        initDbPostgres();
        await db.$connect();
    }, 120_000);
    afterAll(async () => {
        try { await shutdownDbClient(); } finally {
            await session?.close();
            restoreEnv(originalEnv);
            if (root) await rm(root, { recursive: true, force: true });
        }
    });

    it('pages beyond the bind boundary and projects current public audience without foreign rows', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const data = (accountId: string) => ({ id: randomUUID(), accountId,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'fixture' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 });
        const template = await db.artifact.create({ data: data(owner.id) });
        const hidden = await db.artifact.create({ data: data(foreign.id) });
        await db.$executeRawUnsafe(`INSERT INTO "Artifact" ("id", "accountId", "header", "headerVersion", "body", "bodyVersion",
            "dataEncryptionKey", "seq", "createdAt", "updatedAt")
            SELECT $1 || lpad(n::text, 5, '0'), "accountId", "header", "headerVersion", "body", "bodyVersion",
                "dataEncryptionKey", "seq", "createdAt", "updatedAt"
            FROM generate_series(1, 35000) n CROSS JOIN "Artifact" WHERE "Artifact"."id" = $2`, `pg-${template.id.slice(0, 8)}-`, template.id);
        const newest = await db.artifact.create({ data: { ...data(owner.id), updatedAt: new Date(template.updatedAt.getTime() + 1) } });
        const publication = await db.publicSessionShare.create({ data: { artifactId: newest.id,
            createdByUserId: owner.id, keyDerivation: 'fragment_v1', tokenHash: new Uint8Array(32) } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };
            const read = async (cursor?: string) => {
                const response = await app.inject({ method: 'GET', url: `/v1/artifacts?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers });
                expect(response.statusCode, response.body).toBe(200);
                return response.json();
            };
            const first = await read();
            expect(first).toHaveLength(2);
            expect(first).toMatchObject([{ id: newest.id, publicAudience: 'retained' }, { publicAudience: 'none' }]);
            const last = first[first.length - 1];
            const cursor = Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url');
            const second = await read(cursor);
            const ids = [...first, ...second].map((row: { id: string }) => row.id);
            expect(new Set(ids).size).toBe(4);
            expect(ids).not.toContain(hidden.id);
            const expected = await db.artifact.findMany({ where: { accountId: owner.id },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 4, select: { id: true } });
            expect(ids).toEqual(expected.map(row => row.id));
            const fullPage = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=500', headers });
            expect(fullPage.statusCode, fullPage.body).toBe(200);
            expect(fullPage.json()).toHaveLength(500);
            expect(fullPage.json()[0]).toMatchObject({ id: newest.id, publicAudience: 'retained' });
            await db.publicSessionShare.delete({ where: { id: publication.id } });
            expect((await read())[0]).toMatchObject({ id: newest.id, publicAudience: 'none', headerVersion: 1, bodyVersion: 1 });
            const retained = await db.artifact.findMany({ where: { accountId: owner.id }, take: 35000, select: { id: true } });
            await db.publicSessionShare.create({ data: { artifactId: retained[0].id,
                createdByUserId: owner.id, keyDerivation: 'fragment_v1', tokenHash: new Uint8Array(32) } });
            const detail = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                payload: { artifactIds: [...retained.map(row => row.id), hidden.id] } });
            expect(detail.statusCode, detail.body).toBe(200);
            const items = detail.json().items;
            expect(items).toHaveLength(35001);
            const expectedBody = encodePlainArtifactStoredContent({ value: 'fixture' });
            expect(items.slice(0, 35000).every((item: { ok: boolean; artifact?: { access: string; bodyVersion: number; body: string }; recipientCensus: unknown }) =>
                item.ok && item.artifact?.access === 'owner' && item.artifact.bodyVersion === 1
                && item.artifact.body === expectedBody && item.recipientCensus === null)).toBe(true);
            expect(items[0]).toMatchObject({ artifact: { publicAudience: 'retained' } });
            expect(items.slice(1, 35000).every((item: { artifact: { publicAudience: string } }) => item.artifact.publicAudience === 'none')).toBe(true);
            expect(items.map((item: { artifactId: string }) => item.artifactId)).toEqual([...retained.map(row => row.id), hidden.id]);
            expect(items[35000]).toMatchObject({ artifactId: hidden.id, ok: false, error: 'artifact_not_found' });
        });
    });

    it('keeps direct, Team and Group candidates subject to current access admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifacts = await Promise.all(['direct', 'team', 'group'].map(() => db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id, kind: 'skill',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: 'fixture' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
        } })));
        await db.artifactAccountGrant.create({ data: { artifactId: artifacts[0].id, accountId: reader.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const team = await db.team.create({ data: { name: 'Inventory Team' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Inventory Group', nameKey: randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id,
            teamMembershipId: member.id, nativeContribution: true } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifacts[1].id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.artifactGroupGrant.create({ data: { artifactId: artifacts[2].id, teamGroupId: group.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const selectedIds = [...artifacts.map(row => row.id), ...Array.from({ length: 34997 }, (_, index) => `missing-${index}`)];
            const readBatch = async () => {
                const response = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers: {
                    'x-test-user-id': reader.id,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                }, payload: { artifactIds: selectedIds } });
                expect(response.statusCode, response.body).toBe(200);
                const items = response.json().items;
                expect(items.map((item: { artifactId: string }) => item.artifactId)).toEqual(selectedIds);
                expect(items.slice(3).every((item: { ok: boolean; error: string }) => !item.ok && item.error === 'artifact_not_found')).toBe(true);
                return items.slice(0, 3);
            };
            const read = async () => {
                const result = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=3', headers: {
                    'x-test-user-id': reader.id,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                } });
                expect(result.statusCode, result.body).toBe(200);
                return result.json();
            };
            expect((await read()).items.map((row: { id: string }) => row.id).sort()).toEqual(artifacts.map(row => row.id).sort());
            expect(await readBatch()).toMatchObject(artifacts.map(() => ({ ok: true, artifact: { access: 'view' }, recipientCensus: null })));
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect((await read()).items).toMatchObject([{ id: artifacts[0].id, access: 'view' }]);
            expect(await readBatch()).toMatchObject([{ ok: true, artifact: { access: 'view' } },
                { ok: false, error: 'artifact_not_found' }, { ok: false, error: 'artifact_not_found' }]);
            await db.artifactAccountGrant.deleteMany({ where: { accountId: reader.id } });
            expect((await read()).items).toEqual([]);
            expect(await readBatch()).toMatchObject(artifacts.map(() => ({ ok: false, error: 'artifact_not_found' })));
        });
    });
});
