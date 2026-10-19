// Cross-package composition runs under the integration harness's app-owned alias resolution.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db } from '../../../../server/sources/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { createArtifact } from '../../../../server/sources/app/artifacts/artifactWriteService';
import { decideArtifactEditProposal } from '../../../../server/sources/app/artifacts/artifactEditProposalService';
import { createDiscussion, postDiscussionMessage } from '../../../../server/sources/app/discussions/mutations';
import { setDiscussionReadCursor } from '../../../../server/sources/app/discussions/readState';
import { registerDiscussionRoutes } from '../../../../server/sources/app/api/routes/discussions/registerDiscussionRoutes';
import { createDiscussionClient, readDiscussionAttentionPage } from '@/sync/api/discussions/discussionActions';
import { createDiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { buildInboxItems, type InboxItemsInput } from '@/components/inbox/inboxItems';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-inbox-discussions-', initAuth: false, initEncrypt: true,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it('takes a cold SQL/HTTP proposal through the real codec and repository into Needs you until the exact Doc owner decides', async () => {
    const authentication = createPresentUserSessionAccessAuthentication();
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
        header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Plan', kind: 'markdown' })),
        body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Before' })),
        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!artifact.ok) throw new Error(artifact.error);
    const scope = { serverId: 'exact-home', accountId: owner.id };
    const doc = { ref: { kind: 'doc' as const, artifactId: artifact.artifact.id, serverId: scope.serverId },
        revision: { headerVersion: 1, bodyVersion: 1 } };
    const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
        creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Plan review' } },
        firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Review' }] } }, mentionedAccountIds: [] },
    } });
    if (!created.ok) throw new Error(created.error);
    const discussionId = created.value.discussion.id;
    const proposed = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
        localId: randomUUID(), mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc },
        content: { t: 'plain', v: { kind: 'doc_edit_proposal', proposal: { target: { ...doc, range: { start: 0, end: 6 }, quote: 'Before' },
            baseRevision: doc.revision, before: 'Before', after: 'After', reason: 'Clarify' } } },
    } });
    if (!proposed.ok) throw new Error(proposed.error);
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: FastifyRequest) => {
        request.userId = owner.id; request.authAuthority = 'present_user'; request.authTokenKind = 'account';
    });
    registerDiscussionRoutes(app);
    const paths: string[] = [];
    // HTTP and credential verification are the only substituted boundaries.
    const options = { scope, availability: 'available' as const, encryption: null,
        request: async (path: string) => { paths.push(path); const response = await app.inject({ method: 'GET', url: path });
            return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } }); } };
    const repository = createDiscussionRepository({ scope, address: { serverId: scope.serverId },
        client: { ...createDiscussionClient(options), attention: (input, signal) => readDiscussionAttentionPage(options, input, signal) } });
    const unmount = repository.mount({ attention: true });
    const base: InboxItemsInput = { sessionPresentation: { sessionsNeedingAttention: [], readySessions: [],
        markAllReadTargets: [], pendingRequestHydrationTargets: [] }, workGroups: [], workflowServerId: scope.serverId,
        accountServerId: scope.serverId, notices: [] };
    const items = () => buildInboxItems({ ...base, discussions: { scope, entries: repository.getSnapshot().attention.discussions } });
    try {
        expect(repository.getSnapshot().threads).toEqual({});
        await repository.refreshAttention();
        expect(items()).toMatchObject([{ type: 'decision', view: 'needs_you', focus: { kind: 'discussion',
            serverId: scope.serverId, id: discussionId, messageId: proposed.value.message.id } }]);
        expect(paths).toEqual(['/v1/discussions/attention']);
        expect(repository.getSnapshot().threads).toEqual({});
        await setDiscussionReadCursor({ authentication, actorAccountId: owner.id, discussionId, lastReadSeq: proposed.value.message.seq });
        await repository.refreshAttention();
        const [decision] = items();
        expect(decision).toMatchObject({ view: 'needs_you', read: true });
        expect(await decideArtifactEditProposal({ authentication, actorAccountId: owner.id, proposalRef: decision!.discussion!.messageRef,
            decision: 'decline' })).toMatchObject({ ok: true, disposition: { state: 'declined' } });
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: discussionId, changedAt: Date.now() }] });
        await vi.waitFor(() => expect(items()).toEqual([]));
    } finally { unmount(); repository.clear(); await app.close(); }
});
