import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Socket } from "socket.io";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ArtifactPrivateRevisionMetadataV1Schema, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1, openEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0, openSessionDataKeyBundleV0, computeContentPublicKeyFingerprint } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { publicShareRoutes } from "@/app/api/routes/share/publicShareRoutes";
import { auth } from "@/app/auth/auth";
import { artifactUpdateHandler } from "@/app/api/socket/artifactUpdateHandler";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { deleteArtifact, migrateArtifactAccountEncryptionInTx, updateArtifactTx } from "./artifactWriteService";
import { applyArtifactRecipientKeyEnvelopesInTx, readArtifactHeaderForCallerInTx } from './artifactAccessService';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { withSqliteReadSnapshot } from '@/storage/prisma';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, readWidgetSurfaceArtifactHeaderV1 } from '@happier-dev/protocol/widgets';

describe("Artifact document grants (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-artifact-grants-", initEncrypt: true, initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "server_sealed" } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function plainAccount() {
        return db.account.create({ data: { encryptionMode: "plain" } });
    }

    async function plainArtifact(ownerAccountId: string) {
        const id = crypto.randomUUID();
        return db.artifact.create({ data: {
            id, accountId: ownerAccountId,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "original" })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1,
        } });
    }

    const protocolHeaders = { "x-happier-account-stored-content-protocol": String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };

    it('serves only widget-area layouts through the existing kind filter and exact consumer schema', async () => {
        const owner = await plainAccount();
        const foreign = await plainAccount();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const createLayout = async (accountId: string, layoutId: string) => {
                const surface = { serverId: 'home', accountId, owner: { kind: 'project' as const, projectId: 'project', layoutId } };
                const layout = { v: 1 as const, surface, name: layoutId, items: [] };
                const id = buildWidgetSurfaceArtifactIdV1(surface);
                const result = await app.inject({ method: 'POST', url: '/v1/artifacts',
                    headers: { ...headers, 'x-test-user-id': accountId }, payload: { id, kind: 'widget_area_layout',
                        header: encodePlainArtifactStoredContent(buildWidgetSurfaceArtifactHeaderV1(layout)),
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(layout) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
                expect(result.statusCode, result.body).toBe(200);
                return id;
            };
            const id = await createLayout(owner.id, 'mine');
            await createLayout(foreign.id, 'foreign');
            const unrelated = await plainArtifact(owner.id);
            const result = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=widget_area_layout&limit=500&includeBody=true', headers });
            expect(result.statusCode, result.body).toBe(200);
            const page = result.json();
            expect(page).toMatchObject({ items: [{ id, kind: 'widget_area_layout' }], hasUnclassified: true });
            expect(page.items).toHaveLength(1);
            expect(readWidgetSurfaceArtifactHeaderV1({ artifactId: id, header: decodePlainArtifactStoredContent(page.items[0].header) }))
                .toMatchObject({ title: 'mine', surface: { accountId: owner.id } });
            expect(page.items.some((row: { id: string }) => row.id === unrelated.id)).toBe(false);
        });
    });

    it('filters coarse kinds, reports authorized unclassified rows, and backfills without changing content', async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const stranger = await plainAccount();
        const unknown = await plainArtifact(owner.id);
        await plainArtifact(stranger.id);
        await db.artifactAccountGrant.createMany({ data: [
            { artifactId: unknown.id, accountId: editor.id, accessLevel: 'edit', createdByAccountId: owner.id },
            { artifactId: unknown.id, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id },
        ] });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const id = crypto.randomUUID();
            const create = await app.inject({ method: 'POST', url: '/v1/artifacts', headers, payload: {
                id, kind: 'skill', header: encodePlainArtifactStoredContent({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }),
                body: encodePlainArtifactStoredContent({ value: 'skill' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            } });
            expect(create.statusCode, create.body).toBe(200);
            const list = async (accountId: string) => app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill&limit=1',
                headers: { 'x-test-user-id': accountId, ...protocolHeaders } });
            const filtered = await list(owner.id);
            expect(filtered.statusCode, filtered.body).toBe(200);
            expect(filtered.json()).toMatchObject({ items: [{ id, kind: 'skill' }], hasUnclassified: true });
            const denied = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`,
                headers: { 'x-test-user-id': viewer.id, ...protocolHeaders }, payload: { kind: 'other', expectedHeaderVersion: 1 } });
            expect(denied.statusCode, denied.body).toBe(404);
            const conflict = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`, headers,
                payload: { kind: 'other', expectedHeaderVersion: 0 } });
            expect(conflict.json()).toMatchObject({ success: false, error: 'version-mismatch', currentHeaderVersion: 1 });
            const set = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`,
                headers: { 'x-test-user-id': editor.id, ...protocolHeaders }, payload: { kind: 'other', expectedHeaderVersion: 1 } });
            expect(set.statusCode, set.body).toBe(200);
            expect(set.json()).toEqual({ success: true });
            const stored = await db.artifact.findUniqueOrThrow({ where: { id: unknown.id } });
            expect(stored).toMatchObject({ kind: 'other', headerVersion: unknown.headerVersion, bodyVersion: unknown.bodyVersion,
                header: unknown.header, body: unknown.body, dataEncryptionKey: unknown.dataEncryptionKey });
            expect(stored.seq).toBe(unknown.seq + 1);
            expect((await db.accountChange.findMany({ where: { artifactId: unknown.id } })).map(row => row.accountId).sort())
                .toEqual([owner.id, editor.id, viewer.id].sort());
            const changedAccount = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
            const repeat = await app.inject({ method: 'POST', url: `/v1/artifacts/${unknown.id}`, headers,
                payload: { kind: 'skill', expectedHeaderVersion: 1 } });
            expect(repeat.json()).toEqual({ success: true });
            // Plain mode derives the hint from its actual header, even on a metadata-only call.
            expect(await db.artifact.findUniqueOrThrow({ where: { id: unknown.id } })).toEqual(stored);
            expect(await db.account.findUniqueOrThrow({ where: { id: owner.id } })).toEqual(changedAccount);
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts/${unknown.id}`, headers });
            expect(exact.json()).toMatchObject({ kind: 'other' });
            const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers, payload: { artifactIds: [unknown.id] } });
            expect(batch.json()).toMatchObject({ items: [{ ok: true, artifact: { kind: 'other' } }] });
            expect((await list(owner.id)).json()).toMatchObject({ items: [{ id }], hasUnclassified: false });
            expect((await list(viewer.id)).json()).toEqual({ items: [], hasUnclassified: false });
            const legacy = await app.inject({ method: 'GET', url: '/v1/artifacts', headers });
            expect(Array.isArray(legacy.json())).toBe(true);
            expect(legacy.json()).toHaveLength(2);
        });
    });

    it('keeps filtered items and the unclassified flag in one snapshot during backfill', async () => {
        const owner = await plainAccount();
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: 'Skill' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1 } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const delegate = (await withSqliteReadSnapshot(async tx => tx)).artifact;
            const original = delegate.findMany.bind(delegate);
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            // Pause the real first filtered DB query, then classify through the canonical transaction owner.
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const rows = await original(...args);
                    if (!paused && args[0]?.where?.kind === 'skill') { paused = true; enter(); await release; }
                    return rows;
                } });
            const response = app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill', headers });
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                const classified = await inTx(tx => updateArtifactTx(tx, { actorUserId: owner.id,
                    artifactId: artifact.id, kind: 'skill', expectedHeaderVersion: 1 }));
                expect(classified).toMatchObject({ ok: true });
                resume();
                const result = await response;
                expect(result.statusCode, result.body).toBe(200);
                const page = result.json();
                expect(page.hasUnclassified || page.items.some((row: { id: string }) => row.id === artifact.id)).toBe(true);
            } finally {
                resume(); await response;
                Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('keeps completeness conservative when the first unclassified grant is revoked and another remains', async () => {
        const owner = await plainAccount();
        const recipient = await plainAccount();
        const first = await plainArtifact(owner.id);
        const second = await plainArtifact(owner.id);
        await db.artifactAccountGrant.createMany({ data: [first, second].map(artifact => ({ artifactId: artifact.id,
            accountId: recipient.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const delegate = (await withSqliteReadSnapshot(async tx => tx)).artifact;
            const original = delegate.findMany.bind(delegate);
            let enter!: () => void;
            let resume!: () => void;
            let witnessId = '';
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            // Revoke the actual selected DB witness after capture, preserving the second live grant.
            Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    const rows = await original(...args);
                    if (!paused && args[0]?.where?.kind === null && args[0]?.take === 1 && rows[0]) {
                        paused = true; witnessId = rows[0].id; enter(); await release;
                    }
                    return rows;
                } });
            const response = app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill',
                headers: { 'x-test-user-id': recipient.id, ...protocolHeaders } });
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                await db.artifactAccountGrant.deleteMany({ where: { artifactId: witnessId, accountId: recipient.id } });
                resume();
                const result = await response;
                expect(result.statusCode, result.body).toBe(200);
                expect(result.json()).toEqual({ items: [], hasUnclassified: true });
            } finally {
                resume(); await response;
                Object.defineProperty(delegate, 'findMany', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('invalidates an opaque old-writer kind when its header changes', async () => {
        const ownerKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const key = tweetnacl.randomBytes(32);
        const header = await sealSessionDataKeyBundleV0({ kind: 'prompt_doc.v2', title: 'Old prompt' }, key);
        const body = await sealSessionDataKeyBundleV0({ body: 'Old body' }, key);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id, kind: 'prompt',
            header, body, headerVersion: 1, bodyVersion: 1,
            dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ recipientPublicKey: ownerKeys.publicKey, dataKey: key, randomBytes: tweetnacl.randomBytes })) } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
            const unsafeHint = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { kind: 'skill', body: privacyKit.encodeBase64(body), expectedBodyVersion: 1 } });
            expect(unsafeHint.statusCode, unsafeHint.body).toBe(400);
            const staleHint = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { kind: 'skill', expectedHeaderVersion: 0, body: privacyKit.encodeBase64(body), expectedBodyVersion: 1 } });
            expect(staleHint.json()).toMatchObject({ success: false, error: 'version-mismatch' });
            const bodyOnly = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { body: privacyKit.encodeBase64(await sealSessionDataKeyBundleV0({ body: 'Edited body' }, key)), expectedBodyVersion: 1 } });
            expect(bodyOnly.json()).toMatchObject({ success: true, bodyVersion: 2 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ kind: 'prompt' });
            const response = await app.inject({ method: 'POST', url: `/v1/artifacts/${artifact.id}`, headers,
                payload: { header: privacyKit.encodeBase64(await sealSessionDataKeyBundleV0({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, key)), expectedHeaderVersion: 1 } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ success: true, headerVersion: 2 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).toMatchObject({ kind: null, bodyVersion: 2 });
            const filtered = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=skill', headers });
            expect(filtered.json()).toEqual({ items: [], hasUnclassified: true });
        });
    });

    it.each(['owner', 'grantee'] as const)('qualifies an exact admitted header from one Artifact row (%s)', async caller => {
        const owner = await plainAccount();
        const grantee = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: grantee.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await withSqliteReadSnapshot(async tx => {
            const delegate = tx.artifact;
            const original = delegate.findFirst.bind(delegate);
            let reads = 0;
            // Preserve Prisma's bound delegate; instrument only the database boundary.
            Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    reads += 1;
                    return await original(...args);
                } });
            try {
                const result = await readArtifactHeaderForCallerInTx(tx, { artifactId: artifact.id,
                    actorAccountId: caller === 'owner' ? owner.id : grantee.id });
                expect(result).toMatchObject({ ok: true, artifact: { id: artifact.id, encryptionMode: 'plain', access: caller === 'owner' ? 'owner' : 'view' } });
                if (!result.ok) throw new Error('Expected an admitted Artifact header');
                expect(decodePlainArtifactStoredContent(privacyKit.encodeBase64(result.artifact.header))).toEqual({ kind: 'workflow-definition.v1' });
                // A single admitted-header query is the explicit readmission contract.
                expect(reads).toBe(1);
            } finally {
                Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('denies an Artifact body after its grant is revoked during the content snapshot', async () => {
        const owner = await plainAccount();
        const recipient = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const url = `/v1/artifacts/${artifact.id}`;
            const headers = { 'x-test-user-id': recipient.id, ...protocolHeaders };
            expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
            const { withSqliteReadSnapshot } = await import('@/storage/prisma');
            const reader = await withSqliteReadSnapshot(async tx => tx);
            const delegate = reader.artifact;
            const original = delegate.findFirst.bind(delegate);
            let enter!: () => void;
            let resume!: () => void;
            const reached = new Promise<void>(resolve => { enter = resolve; });
            const release = new Promise<void>(resolve => { resume = resolve; });
            let paused = false;
            // Pause the genuine DB query after access/header admission; all policy and bytes stay real.
            Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
                value: async (...args: Parameters<typeof original>) => {
                    if (!paused && args[0]?.select?.body === true) {
                        paused = true; enter(); await release;
                    }
                    return await original(...args);
                } });
            const response = app.inject({ method: 'GET', url, headers });
            try {
                expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
                await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: recipient.id } });
                resume();
                const result = await response;
                expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
                expect(result.statusCode).toBe(404);
            } finally {
                resume(); await response;
                Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original });
            }
        });
    });

    it('projects retained public audience on authenticated reads with public sharing disabled, until expiry or deletion', async () => {
        const owner = await plainAccount();
        const stranger = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        const publication = await db.publicSessionShare.create({ data: {
            artifactId: artifact.id, createdByUserId: owner.id, keyDerivation: 'fragment_v1',
            tokenHash: createHash('sha256').update(crypto.randomUUID()).digest(),
            maxUses: 1, useCount: 1,
        } });
        const previous = process.env.HAPPIER_BUILD_FEATURES_DENY;
        process.env.HAPPIER_BUILD_FEATURES_DENY = 'sharing.public';
        try {
            await withAuthenticatedTestApp(app => { artifactsRoutes(app); publicShareRoutes(app); }, async app => {
                const headers = { 'x-test-user-id': owner.id, ...protocolHeaders };
                const detailUrl = `/v1/artifacts/${artifact.id}`;
                const readAudience = async (expected: 'retained' | 'none') => {
                    const response = await app.inject({ method: 'GET', url: detailUrl, headers });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(response.json()).toMatchObject({ publicAudience: expected });
                    const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers,
                        payload: { artifactIds: [artifact.id] } });
                    expect(batch.statusCode, batch.body).toBe(200);
                    expect(batch.json().items).toMatchObject([{ artifactId: artifact.id, ok: true,
                        artifact: { publicAudience: expected } }]);
                };
                expect((await app.inject({ method: 'GET',
                    url: `/v1/public-shares?subjectKind=artifact&subjectId=${artifact.id}`, headers })).statusCode).toBe(404);
                await readAudience('retained');
                for (const url of [detailUrl, `${detailUrl}/access/grants`]) {
                    expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': stranger.id } })).statusCode).toBe(404);
                    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
                }
                await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: new Date(0) } });
                await readAudience('none');
                await db.publicSessionShare.update({ where: { id: publication.id }, data: { expiresAt: null } });
                await readAudience('retained');
                await db.publicSessionShare.delete({ where: { id: publication.id } });
                await readAudience('none');
            });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_BUILD_FEATURES_DENY;
            else process.env.HAPPIER_BUILD_FEATURES_DENY = previous;
        }
    });

    it.each(['plain', 'e2ee'] as const)('publishes revision-bound private attribution in the real %s header-only HTTP inventory', async mode => {
        const ownerKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(ownerKeys.publicKey) : {}) } });
        const artifactId = crypto.randomUUID();
        const contentKey = tweetnacl.randomBytes(32);
        const privateKey = tweetnacl.randomBytes(32);
        const source = { sessionId: 'source-session', runId: 'source-run', machineId: 'source-machine', path: 'private/output.ts', sha: 'a'.repeat(64) };
        const provenance = { savedBy: { kind: 'agent' as const, accountId: owner.id, sessionId: source.sessionId }, source };
        const metadata = ArtifactPrivateRevisionMetadataV1Schema.parse({ v: 1, artifactId, bodyVersion: 2, provenance });
        const seal = async (value: unknown, key: Uint8Array) => new Uint8Array(mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)) : await sealSessionDataKeyBundleV0(value, key));
        const wrap = (key: Uint8Array, publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes }));
        await db.artifact.create({ data: { id: artifactId, accountId: owner.id,
            header: await seal({ title: 'Published output' }, contentKey),
            body: await seal({ body: 'export const output = 1;' }, contentKey),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) : wrap(contentKey, ownerKeys.publicKey),
            provenance: await seal(metadata, privateKey),
            provenanceDataEncryptionKey: mode === 'plain' ? null : wrap(privateKey, ownerKeys.publicKey), headerVersion: 1, bodyVersion: 2,
        } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: { 'x-test-user-id': owner.id, ...protocolHeaders } });
            expect(response.statusCode, response.body).toBe(200);
            const rows = response.json();
            const wire = rows.find((row: { id: string }) => row.id === artifactId);
            expect(wire).not.toHaveProperty('body');
            expect(wire).toMatchObject({ bodyVersion: 2, provenance: expect.any(String) });
            if (mode === 'plain') {
                expect(ArtifactPrivateRevisionMetadataV1Schema.parse(decodePlainArtifactStoredContent(wire.provenance))).toEqual(metadata);
                expect(decodePlainArtifactStoredContent(wire.header)).toEqual({ title: 'Published output' });
            }
            if (mode === 'e2ee') {
                const ownerPrivateKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(wire.provenanceDataEncryptionKey), recipientSecretKeyOrSeed: ownerKeys.secretKey });
                expect(ownerPrivateKey).toEqual(privateKey);
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(wire.provenance), ownerPrivateKey!)).toMatchObject({ status: 'authenticated', value: metadata });
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(wire.header), contentKey)).toMatchObject({ status: 'authenticated', value: { title: 'Published output' } });
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(wire.provenance), contentKey)).toEqual({ status: 'authentication_failed' });
                const viewerKeys = tweetnacl.box.keyPair();
                const viewer = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(viewerKeys.publicKey) } });
                await db.artifactAccountGrant.create({ data: { artifactId, accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id } });
                await db.artifactKeyEnvelope.create({ data: { artifactId, recipientAccountId: viewer.id,
                    encryptedDataKey: wrap(contentKey, viewerKeys.publicKey), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(viewerKeys.publicKey) } });
                const contentOnly = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: { 'x-test-user-id': viewer.id, ...protocolHeaders } });
                expect(contentOnly.statusCode).toBe(200);
                expect(contentOnly.json()[0]).toMatchObject({ id: artifactId, bodyVersion: 2, provenance: null, provenanceDataEncryptionKey: null });
                expect(contentOnly.json()[0]).not.toHaveProperty('body');
                const viewerContentKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(contentOnly.json()[0].dataEncryptionKey), recipientSecretKeyOrSeed: viewerKeys.secretKey });
                expect(viewerContentKey).toEqual(contentKey);
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(contentOnly.json()[0].header), viewerContentKey!)).toMatchObject({ status: 'authenticated', value: { title: 'Published output' } });
                await db.artifactKeyEnvelope.update({ where: { artifactId_recipientAccountId: { artifactId, recipientAccountId: viewer.id } },
                    data: { encryptedProvenanceDataKey: wrap(privateKey, viewerKeys.publicKey) } });
                const granted = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: { 'x-test-user-id': viewer.id, ...protocolHeaders } });
                expect(granted.statusCode).toBe(200);
                expect(granted.json()[0].provenanceDataEncryptionKey).not.toBe(wire.provenanceDataEncryptionKey);
                expect(granted.json()[0]).not.toHaveProperty('body');
                const viewerPrivateKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(granted.json()[0].provenanceDataEncryptionKey), recipientSecretKeyOrSeed: viewerKeys.secretKey });
                expect(viewerPrivateKey).toEqual(privateKey);
                expect(await openSessionDataKeyBundleV0(privacyKit.decodeBase64(granted.json()[0].provenance), viewerPrivateKey!)).toMatchObject({ status: 'authenticated', value: metadata });
            }
        });
    });

    it.each(["account", "team", "group"] as const)("reports committed %s self-revocation without disclosing the remaining grants", async kind => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const admin = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const remaining = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const artifact = await db.artifact.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, header: new Uint8Array([1]), body: new Uint8Array([2]),
            dataEncryptionKey: wrap(owner.contentPublicKey!), headerVersion: 1, bodyVersion: 1,
        } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: remaining.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        const team = await db.team.create({ data: { name: "Self-revocation team" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: admin.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Administrators", nameKey: crypto.randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true } });
        const principal = kind === "account" ? { kind, accountId: admin.id }
            : kind === "team" ? { kind, teamId: team.id } : { kind, teamId: team.id, groupId: group.id };
        const { readArtifactRecipientCensusInTx, resolveArtifactAccessInTx, setArtifactAccessGrantInTx } = await import("./artifactAccessService");
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, {
            actorAccountId: owner.id, artifactId: artifact.id, principal, accessLevel: "admin",
        }))).toMatchObject({ ok: true });
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: artifact.id }));
        if (!census.ok) throw new Error(census.error);
        for (const recipient of [admin, remaining]) {
            const fingerprint = census.value.recipients.find(row => row.recipientAccountId === recipient.id)!.contentPublicKeyFingerprint!;
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: recipient.id,
                encryptedDataKey: wrap(recipient.contentPublicKey!), recipientContentPublicKeyFingerprint: fingerprint } });
        }
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const revoked = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal } });
            expect(await inTx(tx => resolveArtifactAccessInTx(tx, { actorAccountId: admin.id, artifactId: artifact.id }))).toBeNull();
            expect(await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id }, select: { recipientAccountId: true } }))
                .toEqual([{ recipientAccountId: remaining.id }]);
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toEqual({ artifactId: artifact.id, ownerAccountId: owner.id, access: null, grants: [], changed: true });
            for (const url of [grantsUrl, `/v1/artifacts/${artifact.id}`, `/v1/artifacts/${artifact.id}/access/recipients`]) {
                expect((await app.inject({ method: "GET", url, headers: { "x-test-user-id": admin.id } })).statusCode).toBe(404);
            }
            const ownerList = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": owner.id } });
            expect(ownerList.json()).toMatchObject({ access: "owner", grants: [
                { principal: { kind: "account", accountId: remaining.id }, accessLevel: "view" },
            ] });
        });
    });

    it("projects remaining Team access after self-revocation and refuses further grant writes", async () => {
        const owner = await plainAccount();
        const admin = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        const team = await db.team.create({ data: { name: "Remaining access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: admin.id, role: "member" } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: admin.id,
            accessLevel: "admin", createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const payload = { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id } };
            const removed = await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": admin.id }, payload });
            expect(removed.statusCode).toBe(200);
            expect(removed.json()).toMatchObject({ access: "view", changed: true, grants: [
                { principal: { kind: "team", teamId: team.id }, accessLevel: "view" },
            ] });
            expect((await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": admin.id }, payload })).statusCode).toBe(403);
            const repeated = await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": owner.id }, payload });
            expect(repeated.statusCode).toBe(200);
            expect(repeated.json()).toMatchObject({ access: "owner", changed: false });
        });
    });

    it("rotates a shared Artifact key and retains only prepared recipients with live access and current keys", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const recipients = await Promise.all([0, 1, 2].map(() => db.account.create({
            data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() },
        })));
        const oldKey = tweetnacl.randomBytes(32);
        const replacementKey = tweetnacl.randomBytes(32);
        const wrap = (key: Uint8Array, publicKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        })).toString('base64');
        const sourceOwnerEnvelope = wrap(oldKey, owner.contentPublicKey!);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new Uint8Array([1, 2, 3]), body: new Uint8Array([4, 5, 6]),
            dataEncryptionKey: Buffer.from(sourceOwnerEnvelope, 'base64'), headerVersion: 1, bodyVersion: 1,
        } });
        for (const recipient of recipients) {
            await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        }
        const { readArtifactRecipientCensusInTx } = await import("./artifactAccessService");
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: artifact.id }));
        if (!census.ok) throw new Error(census.error);
        const prepared = recipients.map(recipient => ({ recipientAccountId: recipient.id,
            recipientContentPublicKeyFingerprint: census.value.recipients.find(row => row.recipientAccountId === recipient.id)!.contentPublicKeyFingerprint!,
            encryptedDataKey: wrap(replacementKey, recipient.contentPublicKey!),
        }));
        for (const envelope of prepared) {
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: envelope.recipientAccountId,
                encryptedDataKey: privacyKit.decodeBase64(wrap(oldKey, recipients.find(row => row.id === envelope.recipientAccountId)!.contentPublicKey!)),
                recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } });
        }
        await db.account.update({ where: { id: recipients[1]!.id }, data: createSignedAccountContentBinding() });
        await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: recipients[2]!.id } });
        const directive = { action: "migrate" as const, items: [{ artifactId: artifact.id,
            expectedHeaderVersion: 1, expectedBodyVersion: 1,
            expectedDataEncryptionKey: sourceOwnerEnvelope,
            header: privacyKit.encodeBase64(new Uint8Array([7, 8, 9])), body: privacyKit.encodeBase64(new Uint8Array([10, 11, 12])),
            dataEncryptionKey: wrap(replacementKey, owner.contentPublicKey!), recipientKeyEnvelopes: prepared, revisions: [], blobs: [],
        }] };
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee",
            directive: { ...directive, items: [{ ...directive.items[0]!, expectedDataEncryptionKey: wrap(oldKey, owner.contentPublicKey!) }] } })))
            .toEqual({ status: "migration_incomplete" });
        const invalidEnvelope = Buffer.from(prepared[0]!.encryptedDataKey, 'base64');
        invalidEnvelope[0] = 255; // An unsupported format, not a well-sized legacy V0 envelope.
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee",
            directive: { ...directive, items: [{ ...directive.items[0]!, recipientKeyEnvelopes: [{ ...prepared[0]!,
                encryptedDataKey: invalidEnvelope.toString('base64') }] }] } })))
            .toEqual({ status: "invalid_content" });
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee", directive })))
            .toEqual({ status: "applied" });
        const envelopes = await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id } });
        expect(envelopes.map(row => row.recipientAccountId)).toEqual([recipients[0]!.id]);
        expect(privacyKit.encodeBase64(new Uint8Array(envelopes[0]!.encryptedDataKey))).toBe(prepared[0]!.encryptedDataKey);
        expect(await db.accountChange.count({ where: { accountId: recipients[1]!.id, kind: 'artifact', entityId: artifact.id } })).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: recipients[2]!.id, kind: 'artifact', entityId: artifact.id } })).toBe(0);
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "plain", directive: {
            action: "migrate", items: [{ artifactId: artifact.id, expectedHeaderVersion: 2, expectedBodyVersion: 2,
                expectedDataEncryptionKey: directive.items[0]!.dataEncryptionKey,
                header: encodePlainArtifactStoredContent({ title: 'Shared' }), body: encodePlainArtifactStoredContent({ body: 'Content' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], revisions: [], blobs: [] }],
        } }))).toEqual({ status: "applied" });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
    });

    it("socket reads and writes resolve the same live grants as HTTP", async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: editor.id,
            accessLevel: "edit", createdByAccountId: owner.id } });
        const token = await auth.createToken(editor.id, undefined, { kind: "account", authority: "present_user" });
        const socket = Object.assign(createFakeSocket({ data: {
            clientType: "user-scoped", accountStoredContentCompatibility: {
                supportsCurrentProtocol: true, outcome: "accepted", declaration: null, upgradeRequired: null,
            },
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        artifactUpdateHandler(editor.id, socket as unknown as Socket);
        const read = vi.fn();
        await getSocketHandler(socket, "artifact-read")({ artifactId: artifact.id }, read);
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ result: "success", artifact: expect.objectContaining({
            ownerAccountId: owner.id, access: "edit", header: privacyKit.encodeBase64(artifact.header),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) }));
        const write = vi.fn();
        await getSocketHandler(socket, "artifact-update")({ artifactId: artifact.id, body: {
            data: encodePlainArtifactStoredContent({ value: "socket edit" }), expectedVersion: 1,
        } }, write);
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ result: "success", body: { version: 2,
            data: encodePlainArtifactStoredContent({ value: "socket edit" }) } }));
        await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: editor.id } });
        const revoked = vi.fn();
        await getSocketHandler(socket, "artifact-read")({ artifactId: artifact.id }, revoked);
        expect(revoked).toHaveBeenCalledWith({ result: "error", message: "Artifact not found" });
    });

    it("owner and admin grant routes expose shared plain headers and revoke reads without key material", async () => {
        const owner = await plainAccount();
        const admin = await plainAccount();
        const outsider = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const set = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id }, accessLevel: "admin" } });
            expect(set.statusCode).toBe(200);
            expect(set.json()).toMatchObject({ access: "owner", changed: true });
            const list = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": admin.id } });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toMatchObject({ ownerAccountId: owner.id, access: "admin", grants: [
                { principal: { kind: "account", accountId: admin.id }, accessLevel: "admin", display: { name: null, username: null } },
            ] });
            const delegated = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id }, accessLevel: "view" } });
            expect(delegated.statusCode).toBe(200);
            const refused = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id }, accessLevel: "admin" } });
            expect(refused.statusCode).toBe(403);
            const removed = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id } } });
            expect(removed.statusCode).toBe(200);
            const read = await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ ownerAccountId: owner.id, access: "admin", encryptionMode: "plain",
                header: privacyKit.encodeBase64(artifact.header), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
            const shared = await app.inject({ method: "GET", url: "/v1/artifacts",
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } });
            expect(shared.statusCode).toBe(200);
            expect(shared.json()).toMatchObject([{ id: artifact.id, ownerAccountId: owner.id, access: "admin" }]);
            const absent = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": outsider.id } });
            expect(absent.statusCode).toBe(404);
            const keyless = await app.inject({ method: "POST", url: `/v1/artifacts/${artifact.id}/access/key-envelopes`,
                headers: { "x-test-user-id": owner.id }, payload: { artifactId: artifact.id,
                    expectedDataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(105)), recipientKeyEnvelopes: [] } });
            expect(keyless.statusCode).toBe(400);
            expect(keyless.json()).toEqual({ error: "data_key_not_required" });
            const revoked = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id } } });
            expect(revoked.statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } })).statusCode).toBe(404);
        });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
    });

    it("Team and Group grants use live membership and highest access, including removal and archival", async () => {
        const owner = await plainAccount();
        const member = await plainAccount();
        const team = await db.team.create({ data: { name: "Document team" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Editors", nameKey: crypto.randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true } });
        const artifact = await plainArtifact(owner.id);
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            for (const grant of [
                { principal: { kind: "team", teamId: team.id }, accessLevel: "view" },
                { principal: { kind: "group", teamId: team.id, groupId: group.id }, accessLevel: "edit" },
            ]) {
                const set = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                    payload: { artifactId: artifact.id, ...grant } });
                expect(set.statusCode).toBe(200);
            }
            const read = () => app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": member.id, ...protocolHeaders } });
            expect((await read()).json()).toMatchObject({ access: "edit" });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            expect((await read()).json()).toMatchObject({ access: "view" });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            expect((await read()).statusCode).toBe(404);
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
            expect((await read()).json()).toMatchObject({ access: "view" });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect((await read()).statusCode).toBe(404);
        });
    });

    it('set-acquires Resource recipients and grants while preserving current-binding skips and input order', async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const recipients = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' },
        })));
        const plain = await plainAccount();
        const key = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode('opaque header'), body: new TextEncoder().encode('opaque body'),
            dataEncryptionKey: wrap(owner.contentPublicKey!) } });
        const team = await db.team.create({ data: { name: 'Recipient acquisition' } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id } });
        await db.teamMembership.createMany({ data: recipients.map(recipient => ({ teamId: team.id, accountId: recipient.id, role: 'member' })) });
        // Overlapping direct/Team grants must keep the valid recipient admitted once.
        await db.artifactAccountGrant.createMany({ data: [recipients[0], plain].map(recipient => ({
            artifactId: artifact.id, accountId: recipient.id, accessLevel: 'edit', createdByAccountId: owner.id,
        })) });
        const entries = [...recipients, plain, owner].map(recipient => ({ recipientAccountId: recipient.id,
            encryptedDataKey: privacyKit.encodeBase64(wrap(recipient.contentPublicKey ?? owner.contentPublicKey!)),
            recipientContentPublicKeyFingerprint: recipient.contentPublicKey ? computeContentPublicKeyFingerprint(recipient.contentPublicKey) : 'unavailable' }));
        await db.account.update({ where: { id: recipients[1].id }, data: createSignedAccountContentBinding() });
        await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: recipients[2].id } });
        const apply = (recipientKeyEnvelopes: typeof entries) => inTx(async tx => {
            const observed = observePrismaReads(tx, ['account', 'artifact']);
            const value = await applyArtifactRecipientKeyEnvelopesInTx(observed.tx, { artifactId: artifact.id, recipientKeyEnvelopes });
            return { value, reads: observed.reads };
        });
        const single = await apply(entries.slice(0, 1));
        const multiple = await apply(entries);
        expect(single.value).toEqual({ appliedRecipientAccountIds: [recipients[0].id], skippedRecipientAccountIds: [] });
        expect(multiple.value).toEqual({ appliedRecipientAccountIds: [recipients[0].id],
            skippedRecipientAccountIds: [recipients[1].id, recipients[2].id, plain.id, owner.id] });
        expect(await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id }, select: { recipientAccountId: true } }))
            .toEqual([{ recipientAccountId: recipients[0].id }]);
        expect(single.reads).toHaveLength(2);
        expect(multiple.reads).toHaveLength(single.reads.length);
    });

    it("recipient preparation rechecks keys and memberships and never projects the owner's envelope to a grantee", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const editor = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const late = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const plain = await plainAccount();
        const team = await db.team.create({ data: { name: "Encrypted documents" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: editor.id, role: "member" } });
        const dataKey = tweetnacl.randomBytes(32);
        const ownerKey = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode("opaque header"), body: new TextEncoder().encode("opaque body"), dataEncryptionKey: ownerKey,
            headerVersion: 1, bodyVersion: 1 } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: "edit", createdByAccountId: owner.id } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: plain.id, accessLevel: "view", createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { "x-test-user-id": owner.id };
            const censusUrl = `/v1/artifacts/${artifact.id}/access/recipients`;
            const commitUrl = `/v1/artifacts/${artifact.id}/access/key-envelopes`;
            const census = () => app.inject({ method: "GET", url: censusUrl, headers });
            const before = (await census()).json();
            expect(before.recipients).toContainEqual(expect.objectContaining({ recipientAccountId: plain.id,
                contentKey: { status: "unavailable", reason: "plain_account" } }));
            const editorRow = before.recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === editor.id);
            const editorKey = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: editor.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
            const commit = await app.inject({ method: "POST", url: commitUrl, headers, payload: { artifactId: artifact.id,
                expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{ recipientAccountId: editor.id,
                    encryptedDataKey: editorKey, recipientContentPublicKeyFingerprint: editorRow.contentPublicKeyFingerprint }] } });
            expect(commit.statusCode).toBe(200);
            expect(commit.json()).toEqual({ appliedRecipientAccountIds: [editor.id], skippedRecipientAccountIds: [] });
            const opened = await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": editor.id } });
            expect(opened.json()).toMatchObject({ dataEncryptionKey: editorKey, ownerAccountId: owner.id, access: "edit" });
            const editedCiphertext = new TextEncoder().encode("opaque edited body");
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: editedCiphertext, expectedVersion: 1 } })))
                .toMatchObject({ ok: true, body: { version: 2 } });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).body)
                .toEqual(editedCiphertext);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": plain.id } })).statusCode).toBe(409);
            const lateMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: late.id, role: "member" } });
            const editorCensus = await app.inject({ method: "GET", url: censusUrl, headers: { "x-test-user-id": editor.id } });
            expect(editorCensus.statusCode).toBe(200);
            const lateRow = editorCensus.json().recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === late.id);
            expect(lateRow.encryptedDataKey).toBeNull();
            await db.teamMembership.delete({ where: { id: lateMembership.id } });
            const lateEnvelope = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: late.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
            const removed = await app.inject({ method: "POST", url: commitUrl, headers: { "x-test-user-id": editor.id }, payload: {
                artifactId: artifact.id, expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{
                    recipientAccountId: late.id, encryptedDataKey: lateEnvelope, recipientContentPublicKeyFingerprint: lateRow.contentPublicKeyFingerprint,
                }],
            } });
            expect(removed.json()).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [late.id] });
            expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id, recipientAccountId: late.id } })).toBe(0);
            await db.account.update({ where: { id: editor.id }, data: { ...createSignedAccountContentBinding() } });
            const rebound = await app.inject({ method: 'POST', url: commitUrl, headers, payload: {
                artifactId: artifact.id, expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{
                    recipientAccountId: editor.id, encryptedDataKey: editorKey,
                    recipientContentPublicKeyFingerprint: editorRow.contentPublicKeyFingerprint,
                }],
            } });
            expect(rebound.statusCode, rebound.body).toBe(200);
            expect(rebound.json()).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [editor.id] });
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": editor.id } })).statusCode).toBe(409);
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: editedCiphertext, expectedVersion: 2 } })))
                .toMatchObject({ ok: false, error: "not-found" });
            const transition = await inTx(async tx => migrateArtifactAccountEncryptionInTx({
                tx, accountId: owner.id, fromMode: "e2ee", toMode: "plain", directive: { action: "migrate", items: [{
                    artifactId: artifact.id, expectedHeaderVersion: 1, expectedBodyVersion: 2,
                    expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [],
                    header: encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }),
                    body: encodePlainArtifactStoredContent({ value: "plain replacement" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    blobs: [],
                    revisions: (await tx.artifactRevision.findMany({ where: { artifactId: artifact.id } })).map(revision => ({
                        bodyVersion: revision.bodyVersion, expectedBody: privacyKit.encodeBase64(new Uint8Array(revision.body)),
                        body: encodePlainArtifactStoredContent({ body: "Retained content" }),
                    })),
                }] },
            }));
            expect(transition).toEqual({ status: "applied" });
            expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
        });
    });

    it("an editor CAS uses the owner's plain storage path and notifies every current recipient", async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.createMany({ data: [
            { artifactId: artifact.id, accountId: editor.id, accessLevel: "edit", createdByAccountId: owner.id },
            { artifactId: artifact.id, accountId: viewer.id, accessLevel: "view", createdByAccountId: owner.id },
        ] });
        const body = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "edited" }));
        const write = await inTx(tx => updateArtifactTx(tx, {
            actorUserId: editor.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 },
        }));
        expect(write).toMatchObject({ ok: true, body: { version: 2 } });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).body).not.toEqual(body);
        const notices = await db.accountChange.findMany({ where: { artifactId: artifact.id }, select: { accountId: true } });
        expect(notices.map(row => row.accountId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
        await expect(inTx(tx => updateArtifactTx(tx, {
            actorUserId: editor.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 },
        }))).resolves.toMatchObject({ ok: false, error: "version-mismatch", current: { bodyVersion: 2, body } });
        await expect(inTx(tx => updateArtifactTx(tx, {
            actorUserId: viewer.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 2 },
        }))).resolves.toMatchObject({ ok: false, error: "not-found" });
        await expect(deleteArtifact({ actorUserId: editor.id, artifactId: artifact.id }))
            .resolves.toMatchObject({ ok: false, error: "not-found" });
        expect(await db.artifact.count({ where: { id: artifact.id } })).toBe(1);
        const beforeDelete = await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } });
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id,
            expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
            .resolves.toMatchObject({ ok: false, error: "version-mismatch" });
        expect(await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } })).toEqual(beforeDelete);
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id }))
            .resolves.toMatchObject({ ok: true });
        const deletedNotices = await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } });
        expect(deletedNotices.map(row => row.accountId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
        for (const notice of deletedNotices) {
            expect(notice.cursor).toBeGreaterThan(beforeDelete.find(row => row.accountId === notice.accountId)!.cursor);
        }
    });
});
