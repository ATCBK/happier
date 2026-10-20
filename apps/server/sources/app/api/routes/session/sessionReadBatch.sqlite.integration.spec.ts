import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionRoutes } from './sessionRoutes';

describe('Session id-batched reads (SQLite integration)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-read-batch-', env: {
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        } });
    }, 120_000);
    afterAll(async () => { await harness.close(); vi.unstubAllEnvs(); });

    it('returns the existing admitted snapshot and first message page independently for mixed ids and modes', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { publicKey: crypto.randomUUID() } });
        const plain = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const encrypted = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: 'sealed-metadata', encryptionMode: 'e2ee' } });
        const denied = await db.session.create({ data: { accountId: foreign.id, tag: crypto.randomUUID(), metadata: 'private' } });
        const corrupt = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionMessage.createMany({ data: Array.from({ length: 151 }, (_, index) => ({
            sessionId: plain.id, seq: index + 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `input ${index}` } } },
        })) });
        await db.sessionMessage.createMany({ data: [
            { sessionId: plain.id, seq: 152, messageRole: 'event', sidechainId: 'child', content: { t: 'plain', v: { type: 'event' } } },
            { sessionId: plain.id, seq: 153, messageRole: 'unknown', content: { t: 'plain', v: { type: 'excluded row' } } },
            { sessionId: encrypted.id, seq: 1, messageRole: 'agent', content: { t: 'encrypted', c: 'sealed-content' } },
            { sessionId: corrupt.id, seq: 1, messageRole: 'user', content: { t: 'plain', v: null } },
        ] });
        // Corrupt retained storage is a database boundary fixture, not a current writer shape.
        await db.$executeRaw`UPDATE "SessionMessage" SET "content" = ${JSON.stringify({ t: 'unexpected' })} WHERE "sessionId" = ${corrupt.id}`;
        await db.sessionTurn.create({ data: { sessionId: plain.id, turnId: 'completed-turn', status: 'completed',
            startedAt: 10n, updatedAt: 20n, terminalAt: 20n } });
        const ids = [plain.id, encrypted.id, denied.id, 'missing-session', corrupt.id];
        await withAuthenticatedTestApp(sessionRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' };
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: ids, accessProjectionVersion: 1, includeSnapshot: true, includeMessages: true } });
            expect(response.statusCode).toBe(200);
            const { results } = response.json();
            expect(SessionReadBatchResponseV1Schema.safeParse(response.json()).success).toBe(true);
            expect(results.map((result: { sessionId: string }) => result.sessionId)).toEqual(ids);
            for (const result of results) {
                const detail = await app.inject({ method: 'GET', url: `/v2/sessions/${result.sessionId}?accessProjectionVersion=1`, headers });
                expect(result.detail).toEqual({ status: detail.statusCode, body: detail.json() });
                if (detail.statusCode !== 200) {
                    expect(result.turns).toBeUndefined();
                } else {
                    const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${result.sessionId}/turns`, headers });
                    expect(result.turns).toEqual({ status: turns.statusCode, body: turns.json() });
                }
                const messages = await app.inject({ method: 'GET', url: `/v1/sessions/${result.sessionId}/messages?scope=all&roles=user,agent,event`, headers });
                expect(result.messages).toEqual({ status: messages.statusCode, body: messages.json() });
            }
            expect(results[0].messages.body).toMatchObject({ hasMore: true, nextBeforeSeq: 3, nextAfterSeq: null });
            expect(results[0].turns.body.turns).toMatchObject([{ turnId: 'completed-turn', status: 'completed' }]);
            expect(results[0].messages.body.messages).toHaveLength(150);
            expect(results[0].messages.body.messages[0]).toMatchObject({ seq: 152, messageRole: 'event', sidechainId: 'child' });
            expect(results[1].messages.body.messages[0].content).toEqual({ t: 'encrypted', c: 'sealed-content' });
            expect(results[4]).toMatchObject({ detail: { status: 200 }, messages: { status: 503, body: { error: 'session_transcript_stored_content_unavailable' } } });

            const snapshot = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [plain.id], accessProjectionVersion: 1 } });
            expect(snapshot.json().results[0]).toMatchObject({ detail: { status: 200 }, turns: { status: 200 } });
            expect(snapshot.json().results[0].messages).toBeUndefined();
            const transcript = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [plain.id], accessProjectionVersion: 1, includeSnapshot: false, includeMessages: true } });
            expect(transcript.json().results[0].detail).toBeUndefined();
            expect(transcript.json().results[0].turns).toBeUndefined();
            expect(transcript.json().results[0].messages).toEqual(results[0].messages);
            const invalid = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers,
                payload: { sessionIds: [plain.id], includeSnapshot: false, includeMessages: false } });
            expect(invalid.statusCode).toBe(400);
            const restricted = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { ...headers, 'x-test-auth-token-kind': 'api_token' }, payload: { sessionIds: [plain.id] } });
            expect(restricted.statusCode).toBe(403);
        });
    });

    it('keeps Team continuation, unavailable authentication and revoked access local to their Session', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const binding = createSignedAccountContentBinding();
        const reader = await db.account.create({ data: { publicKey: binding.publicKey, encryptionMode: 'e2ee',
            contentPublicKey: Buffer.from(binding.contentPublicKey), contentPublicKeySig: Buffer.from(binding.contentPublicKeySig) } });
        const team = await db.team.create({ data: { name: 'Restricted', authenticationPolicy: {
            v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: reader.id, role: 'member' },
        ] });
        const protectedSession = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(),
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: JSON.stringify({ t: 'plain', v: { v: 1 } }), currentStorageState: 'hosted' } });
        await db.sessionTeamGrant.create({ data: { sessionId: protectedSession.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date() } });
        const own = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await withAuthenticatedTestApp(sessionRoutes, async app => {
            const read = async (qualified = false) => {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                    headers: { 'x-test-user-id': reader.id, 'x-happier-account-stored-content-protocol': '4',
                        ...(qualified ? { 'x-test-authentication-evidence': JSON.stringify([{ kind: 'home_method', methodId: 'key_challenge' }]) } : {}) },
                    payload: { sessionIds: [own.id, protectedSession.id], accessProjectionVersion: 1, includeMessages: true } });
                expect(response.statusCode, response.body).toBe(200);
                return SessionReadBatchResponseV1Schema.parse(response.json()).results;
            };
            const required = await read();
            expect(required[0]).toMatchObject({ detail: { status: 200 }, turns: { status: 200 }, messages: { status: 200 } });
            expect(required[1]).toMatchObject({ detail: { status: 403, body: { error: 'team_authentication_required' } },
                messages: { status: 403, body: { error: 'team_authentication_required' } } });
            vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '0');
            try {
                const unavailable = await read();
                expect(unavailable[0]?.detail?.status).toBe(200);
                expect(unavailable[1]).toMatchObject({ detail: { status: 503, body: { error: 'team_authentication_unavailable' } },
                    messages: { status: 503, body: { error: 'team_authentication_unavailable' } } });
            } finally { vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '1'); }
            const admitted = (await read(true))[1];
            expect(admitted).toMatchObject({ detail: { status: 200 }, turns: { status: 200 }, messages: { status: 200 } });
            const qualifiedHeaders = { 'x-test-user-id': reader.id, 'x-happier-account-stored-content-protocol': '4',
                'x-test-authentication-evidence': JSON.stringify([{ kind: 'home_method', methodId: 'key_challenge' }]) };
            const currentDetail = await app.inject({ method: 'GET', url: `/v2/sessions/${protectedSession.id}?accessProjectionVersion=1`, headers: qualifiedHeaders });
            expect(currentDetail.statusCode, currentDetail.body).toBe(200);
            expect(admitted?.detail).toEqual({ status: currentDetail.statusCode, body: currentDetail.json() });
            const legacyDetail = await app.inject({ method: 'GET', url: `/v2/sessions/${protectedSession.id}`, headers: qualifiedHeaders });
            expect(legacyDetail.statusCode, legacyDetail.body).toBe(404);
            const legacyBatch = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch', headers: qualifiedHeaders,
                payload: { sessionIds: [protectedSession.id] } });
            expect(legacyBatch.statusCode, legacyBatch.body).toBe(200);
            expect(legacyBatch.json().results[0].detail).toEqual({ status: legacyDetail.statusCode, body: legacyDetail.json() });
            await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: reader.id } });
            expect((await read(true))[1]).toMatchObject({ detail: { status: 404, body: { error: 'Session not found' } },
                messages: { status: 404, body: { error: 'Session not found' } } });
        });
    });

    it('quarantines malformed retained component output without discarding another Session', async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const healthy = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const malformed = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionMessage.create({ data: { id: '', sessionId: malformed.id, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained row without usable identity' } } } } });
        await withAuthenticatedTestApp(sessionRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                payload: { sessionIds: [malformed.id, healthy.id], accessProjectionVersion: 1, includeMessages: true } });
            expect(response.statusCode, response.body).toBe(200);
            expect(SessionReadBatchResponseV1Schema.parse(response.json()).results).toMatchObject([
                { sessionId: malformed.id, detail: { status: 200 }, messages: { status: 503, body: { error: 'session_read_unavailable' } } },
                { sessionId: healthy.id, detail: { status: 200 }, messages: { status: 200, body: { messages: [] } } },
            ]);
        });
    });
});
