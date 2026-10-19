import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { buildDiscussionMutationRequestBodyV1 } from '@happier-dev/protocol/discussions/api';
import { createDiscussion, postDiscussionMessage } from './mutations';
import { inviteDiscussionParticipant } from './accessService';
import { readDiscussionMessages } from './queries';
import { previewDiscussionSecondOpinion } from './secondOpinion';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewResponseV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { registerDiscussionRoutes } from '@/app/api/routes/discussions/registerDiscussionRoutes';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';

const authentication = createPresentUserSessionAccessAuthentication();
const document = (text: string) => ({ v: 1 as const, parts: [{ t: 'text' as const, text }] });

describe('Second opinion source admission (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-second-opinion-', initAuth: false,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const answer = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, messageRole: 'agent', content: { t: 'plain', v: { text: 'Private answer' } } } });
        const request = buildDiscussionMutationRequestBodyV1({ kind: 'create', creationLocalId: crypto.randomUUID(),
            anchor: { kind: 'session', sessionId: source.id, messageId: answer.id },
            titleContent: { t: 'plain', v: { v: 1, title: 'Second opinion' } },
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain', v: document('Private answer') }, authoredContent: document('Private answer'), mentionedAccountIds: [] },
            participants: [{ kind: 'account', accountId: reader.id }] });
        return { owner, reader, source, answer, request };
    }
    it('refuses a quoted source before creating a Discussion for a broader audience', async () => {
        const { owner, request } = await fixture();
        expect(await createDiscussion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussion.count({ where: { creationLocalId: request.creationLocalId } })).toBe(0);
    });
    it('previews the actual reviewer audience even for quote-only without grants, content or allocation', async () => {
        const { owner, reader, source, answer } = await fixture();
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.sessionShare.create({ data: { sessionId: reviewer.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const sourceRef = { kind: 'session' as const, message: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } };
        const request = { source: sourceRef, publisherSessionId: reviewer.id, reviewers: [{ selection: { kind: 'session' as const,
            session: { serverId: 'home', sessionId: reviewer.id } }, sourceAccess: 'quote_only' as const }] };
        const counts = await Promise.all([db.session.count(), db.discussion.count(), db.sessionShare.count()]);
        const preview = await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request });
        expect(DiscussionSecondOpinionPreviewResponseV1Schema.safeParse(preview).success).toBe(true);
        expect(preview).toMatchObject({ ok: true, value: { sourceContentReady: true,
            publisher: { sessionId: reviewer.id, answerPolicy: 'when_addressed', audienceAccountIds: expect.arrayContaining([owner.id, reader.id]),
                disclosure: { ok: false, reason: 'destination_audience_broader' } }, reviewers: [{ runtimeAccountId: owner.id,
            missingSourceAccountIds: [reader.id], canGrantSource: true, sourceAccess: 'quote_only',
            disclosure: { ok: false, reason: 'destination_audience_broader' } }] } });
        expect(JSON.stringify(preview)).not.toContain('Private answer');
        expect(await Promise.all([db.session.count(), db.discussion.count(), db.sessionShare.count()])).toEqual(counts);
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { publisher: { sessionId: reviewer.id, disclosure: { ok: true } },
                reviewers: [{ missingSourceAccountIds: [], disclosure: { ok: true } }] } });
        const uncontrolled = await db.session.create({ data: { accountId: reader.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id,
            request: { ...request, publisherSessionId: uncontrolled.id } }))
            .toEqual({ ok: false, error: 'discussion_subject_ineligible' });
        // A valid ciphertext envelope without the current recipient key stays locked.
        await db.session.update({ where: { id: source.id }, data: { encryptionMode: 'e2ee' } });
        await db.sessionMessage.update({ where: { id: answer.id }, data: { content: { t: 'encrypted', c: 'ciphertext' } } });
        expect(await previewDiscussionSecondOpinion({ authentication, actorAccountId: owner.id, request }))
            .toMatchObject({ ok: true, value: { sourceContentReady: false } });
    });
    it('lets a source-reading Discussion editor ask an invited reviewer without acquiring control of its Session', async () => {
        const { owner, reader, source, request } = await fixture();
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: reviewer.id } } })).toMatchObject({ ok: true });
        expect(await inTx(tx => mayInjectResourceContextInTx(tx, { configuringAccountId: reader.id, authentication,
            source: { kind: 'session', sessionId: source.id }, destination: { kind: 'session', sessionId: reviewer.id } })))
            .toEqual({ ok: false, reason: 'configurer_not_allowed' });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: reviewer.id } },
            { t: 'text' as const, text: 'Please review the source' }] };
        expect(await postDiscussionMessage({ authentication, actorAccountId: reader.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(), content: { t: 'plain', v: content },
                authoredContent: content, mentionedAccountIds: [], mentionedSessionIds: [reviewer.id] }) }))
            .toMatchObject({ ok: true, value: { message: { authorAccountId: reader.id, seq: 2 } } });
    });
    it.each([false, true])('addresses only selected reviewers for an Agent question about its own quote (explicit self mention: %s)', async explicitSelfMention => {
        const { owner, reader, source, request } = await fixture();
        await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const producer = { v: 1 as const, kind: 'agent' as const, sessionId: source.id };
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request, producer });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        for (const sessionId of [source.id, reviewer.id]) expect(await inviteDiscussionParticipant({ authentication,
            actorAccountId: owner.id, discussionId, request: { participant: { kind: 'session', sessionId }, answerPolicy: 'when_addressed' } }))
            .toMatchObject({ ok: true });
        const mentionedSessionIds = [reviewer.id, ...(explicitSelfMention ? [source.id] : [])].sort();
        const content = { v: 1 as const, parts: [...mentionedSessionIds.map(sessionId => ({ t: 'mention' as const,
            participant: { kind: 'session' as const, sessionId } })), { t: 'text' as const, text: 'Please review my answer' }] };
        const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, producer,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(), content: { t: 'plain', v: content },
                authoredContent: content, mentionedAccountIds: [], mentionedSessionIds,
                replyTarget: { kind: 'message', messageId: created.value.firstMessage.id } }) });
        expect(posted).toMatchObject({ ok: true, value: { message: { seq: 2,
            addressingV1: { participantSessionIds: mentionedSessionIds, throughSeq: 2 } } } });
    });
    it('rechecks source disclosure on invite and addressed post, but keeps history after source deletion', async () => {
        const { owner, reader, source, request } = await fixture();
        const share = await db.sessionShare.create({ data: { sessionId: source.id, sharedByUserId: owner.id, sharedWithUserId: reader.id, accessLevel: 'view' } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const reviewer = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'session', sessionId: reviewer.id } } })).toMatchObject({ ok: true });
        await db.sessionShare.delete({ where: { id: share.id } });
        const content = { v: 1 as const, parts: [{ t: 'mention' as const, participant: { kind: 'session' as const, sessionId: reviewer.id } },
            { t: 'text' as const, text: 'Check this answer' }] };
        const post = buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
            content: { t: 'plain', v: content }, authoredContent: content, mentionedAccountIds: [], mentionedSessionIds: [reviewer.id] });
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: post }))
            .toMatchObject({ ok: false, error: 'discussion_access_forbidden' });
        expect(await db.discussionMessage.count({ where: { discussionId } })).toBe(1);
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await inviteDiscussionParticipant({ authentication, actorAccountId: owner.id, discussionId,
            request: { participant: { kind: 'account', accountId: outsider.id } } })).toMatchObject({ ok: false });
        expect(await db.discussionAccountGrant.count({ where: { discussionId, accountId: outsider.id } })).toBe(0);
        expect(await deleteOwnedSession({ sessionId: source.id, ownerAccountId: owner.id, reason: 'user_request' }))
            .toEqual({ ok: true });
        expect(await readDiscussionMessages({ authentication, actorAccountId: reader.id, discussionId }))
            .toMatchObject({ ok: true, value: { messages: [{ id: created.value.firstMessage.id }] } });
        const ordinary = document('The source is now unavailable');
        expect(await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId,
            request: buildDiscussionMutationRequestBodyV1({ kind: 'post', localId: crypto.randomUUID(),
                content: { t: 'plain', v: ordinary }, authoredContent: ordinary, mentionedAccountIds: [] }) })).toMatchObject({ ok: true });
    });
    it('exposes the closed read-only preview route and previews a model without creating its Session', async () => {
        const { owner, source, answer } = await fixture();
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        // Authentication is the system boundary. Route parsing and all access/key/disclosure owners remain real.
        app.decorate('authenticate', async (request: FastifyRequest) => {
            request.userId = owner.id;
            request.authAuthority = 'present_user';
            request.authTokenKind = 'account';
        });
        registerDiscussionRoutes(app);
        const payload = { source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: source.id }, messageId: answer.id } },
            publisherSessionId: source.id,
            reviewers: [{ selection: { kind: 'model', launch: {
                executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/work' },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            } }, participantSlotId: 'slot' }] };
        const before = await db.session.count();
        try {
            const response = await app.inject({ method: 'POST', url: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, payload });
            expect(response.statusCode).toBe(200);
            expect(DiscussionSecondOpinionPreviewResponseV1Schema.parse(response.json())).toMatchObject({ ok: true, value: {
                sourceContentReady: true, discussionAudienceAccountIds: [owner.id], missingDiscussionSourceAccountIds: [],
                publisher: { sessionId: source.id, answerPolicy: 'when_addressed', audienceAccountIds: [owner.id], disclosure: { ok: true } },
                reviewers: [{ runtimeAccountId: null, sourceAccess: 'read', audienceAccountIds: [owner.id], disclosure: { ok: true } }],
            } });
            expect(await db.session.count()).toBe(before);
            expect((await app.inject({ method: 'POST', url: DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1,
                payload: { ...payload, quote: 'Unauthorized preview text' } })).statusCode).toBe(400);
        } finally { await app.close(); }
    });
});
