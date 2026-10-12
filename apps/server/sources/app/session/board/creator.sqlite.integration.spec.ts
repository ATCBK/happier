import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE } from '@happier-dev/protocol';
import { registerSessionSystemRecordRoutes } from '@/app/api/routes/session/registerSessionSystemRecordRoutes';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '@/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { readPublishedSessionSurfaceItemInTx } from '@/app/session/systemRecords/sessionSystemRecordService';
import { mutateSessionBoard } from './service';

describe('Session visual creator persistence', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-visual-creator-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: '1' } });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 300_000);
    afterAll(async () => { resetSessionSystemRecordsProtocolV1ActivationForTests(); await harness?.close(); });

    it('persists immutable creator metadata outside caller-authored visual content', async () => {
        const account = await db.account.create({ data: { publicKey: `creator-${randomUUID()}`, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const itemContent = { t: 'plain' as const, v: { v: 1, destination: 'transcript', title: 'Result', frame: 'frameless',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Hello' } } } } };
        const create = await mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
            mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: null, itemContent } });
        expect(create.ok).toBe(true);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the network boundary; all persistence and projection logic stays real.
        app.decorate('authenticate', async (request: FastifyRequest) => { request.userId = account.id; request.authAuthority = 'present_user'; });
        registerSessionSystemRecordRoutes(app);
        try {
            const query = 'owner=host&namespace=surface&kind=item.v1&localId=visual';
            const headers = { [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE };
            const first = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json().record.creator).toEqual({ kind: 'user' });
            expect(first.json().record.content).toEqual(itemContent);
            const update = await mutateSessionBoard({ actorUserId: account.id, sessionId: session.id,
                authentication: { ...authentication, authority: 'account_automation' },
                creator: { kind: 'session', sessionId: session.id },
                mutation: { operation: 'upsert_item', itemId: 'visual', expectedItemRevision: first.json().record.revision,
                    itemContent: { ...itemContent, v: { ...itemContent.v, title: 'Updated' } } } });
            expect(update.ok).toBe(true);
            const second = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(second.json().record.creator).toEqual({ kind: 'user' });
            const published = await inTx(tx => readPublishedSessionSurfaceItemInTx(tx, {
                accountId: account.id, sessionId: session.id, itemId: 'visual', encryptionMode: 'plain',
            }));
            expect(published?.creator).toEqual({ kind: 'user' });
            expect(published?.content).toEqual({ ...itemContent, v: { ...itemContent.v, title: 'Updated' } });

            // Historical raw rows remain unattributed even when their next writer is known.
            await db.sessionSystemRecord.update({ where: { id: first.json().record.id }, data: { content: itemContent } });
            const legacy = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(legacy.json().record.creator).toEqual({ kind: 'unknown' });
            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                creator: { kind: 'session', sessionId: session.id }, mutation: { operation: 'upsert_item', itemId: 'visual',
                    expectedItemRevision: legacy.json().record.revision, itemContent: { ...itemContent, v: { ...itemContent.v, title: 'Legacy update' } } } })).resolves.toMatchObject({ ok: true });
            const legacyUpdate = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query}`, headers });
            expect(legacyUpdate.json().record.creator).toEqual({ kind: 'unknown' });

            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                creator: { kind: 'session', sessionId: session.id }, mutation: { operation: 'upsert_item', itemId: 'owned', expectedItemRevision: null, itemContent } })).resolves.toMatchObject({ ok: true });
            const ownQuery = query.replace('localId=visual', 'localId=owned');
            const own = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${ownQuery}`, headers });
            expect(own.json().record.creator).toEqual({ kind: 'session', sessionId: session.id });
            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                creator: { kind: 'session', sessionId: session.id }, mutation: { operation: 'upsert_item', itemId: 'owned', expectedItemRevision: own.json().record.revision,
                    itemContent: { ...itemContent, v: { ...itemContent.v, title: 'Resumed caller' } } } })).resolves.toMatchObject({ ok: true });
            const resumed = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${ownQuery}`, headers });
            expect(resumed.json().record.creator).toEqual({ kind: 'session', sessionId: session.id });
            const child = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: child.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'owned', expectedItemRevision: null, itemContent } })).resolves.toMatchObject({ ok: true });
            const copied = await app.inject({ method: 'GET', url: `/v2/sessions/${child.id}/system-records/record?${ownQuery}`, headers });
            expect(copied.json().record.creator).toEqual({ kind: 'user' });
            await expect(mutateSessionBoard({ actorUserId: account.id, sessionId: session.id,
                authentication: { ...authentication, authority: 'account_automation' },
                mutation: { operation: 'upsert_item', itemId: 'unproved', expectedItemRevision: null, itemContent } })).resolves.toMatchObject({ ok: true });
            const unproved = await app.inject({ method: 'GET', url: `/v2/sessions/${session.id}/system-records/record?${query.replace('localId=visual', 'localId=unproved')}`, headers });
            expect(unproved.json().record.creator).toEqual({ kind: 'unknown' });
            const forged = await mutateSessionBoard({ actorUserId: account.id, sessionId: session.id, authentication,
                mutation: { operation: 'upsert_item', itemId: 'forged', expectedItemRevision: null,
                    creator: { kind: 'session', sessionId: session.id }, itemContent } });
            expect(forged).toMatchObject({ ok: false, result: { error: 'session_board_invalid' } });
        } finally { await app.close(); }
    });
});
