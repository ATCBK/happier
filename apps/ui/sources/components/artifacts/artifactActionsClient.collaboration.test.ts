import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { deriveDocCommentDiscussionCreationLocalIdV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionMessageContentV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactPassageQuote } = await import('./ArtifactPassageQuote');
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
const { useDiscussionDraft } = await import('@/components/discussions/useDiscussionDraft');
const { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { buildDiscussionRouteHref } = await import('@/components/discussions/discussionRoutes');
const { createInboxItemRoute, readInboxItemFocus, resolveInboxItemPageRoute } = await import('@/components/inbox/inboxItemFocus');

beforeEach(async () => { await homes.reset(); });
afterEach(async () => { resetSessionDraftRepositoryForTests(); standardCleanup(); await homes.reset(); });

describe('Doc collaboration data through the real Actions and Discussion repository', () => {
    it('rejoins a lost root acknowledgement and reopens that same qualified passage from Doc, Discussion and Inbox', async () => {
        const serverId = await homes.addHome({ name: 'Saved Doc', serverUrl: 'https://doc-comments.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const artifacts = createArtifactActionsClient(scope);
        const source = 'Repeated passage.\n\nRepeated passage.';
        const created = await artifacts.createArtifact({ header: { kind: 'artifact.legacy', title: 'Notes' }, body: source });
        if (!('ok' in created) || !created.ok) throw new Error(`Artifact create failed: ${JSON.stringify(created)}`);
        const doc = await artifacts.readDoc({ ref: { kind: 'doc', serverId, artifactId: created.value.artifactId } });
        if (!doc.ok) throw new Error(`Doc read failed: ${JSON.stringify(doc)}`);
        const passage = captureDocPassageV1({ ref: doc.value.ref, revision: doc.value.artifact.revision, source,
            range: { start: source.lastIndexOf('Repeated'), end: source.length } });
        const network = answerDiscussionThreadForTests(homes, serverId);
        // Changing the selected Home after capture cannot redirect this repository or its Action.
        await homes.addHome({ name: 'Other', serverUrl: 'https://other-doc-comments.test', accountId: 'other', currentAccount: true });
        const client = createDiscussionClient({ scope, availability: 'available' });
        let repository = createDiscussionRepository({ scope, address: { serverId }, client });
        const localId = 'retained-comment';
        const creationLocalId = deriveDocCommentDiscussionCreationLocalIdV1({ ref: doc.value.ref, localId });
        expect(() => artifacts.beginPassageComment({ ...passage, ref: { ...passage.ref, serverId: 'other-home' } }))
            .toThrow('exact captured Home');
        expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })).toBeNull();
        expect(artifacts.beginPassageComment(passage)).toBe(`/discussions/new?serverId=${encodeURIComponent(serverId)}`);
        let draft = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'newDiscussion' } }));
        const quote = await renderScreen(createElement(ArtifactPassageQuote, { testID: 'c5-passage-preview', passage: draft.getCurrent().passage }));
        expect(quote.findByTestId('c5-passage-preview.text')?.props.children).toBe(passage.quote);
        await act(async () => { draft.getCurrent().setComposer({ text: 'Please review the second passage.', mentions: [] }); });
        const content = draft.getCurrent().prepareContent({ v: 1, parts: [{ t: 'text', text: 'Please review the second passage.' }] });
        let submission: DiscussionDraftSubmission | undefined;
        await act(async () => { submission = draft.getCurrent().captureSubmittedCurrentness({ kind: 'create', creationLocalId,
            messageLocalId: localId }, { content, title: 'Document comments' }); });
        const intent = { creationLocalId, messageLocalId: localId, title: 'Document comments', content,
            draftSubmission: submission! };
        expect(await repository.create(intent)).toEqual({ kind: 'checking' });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status).toBe('outcome_unknown'));
        await act(async () => { draft.getCurrent().setText('Newer unfinished question');
            draft.getCurrent().setPassage({ ...passage, ref: { ...passage.ref, artifactId: 'different-doc' } }); });
        await draft.unmount();
        draft = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'newDiscussion' } }));
        const frozen = draft.getCurrent().submitted;
        expect(frozen).toMatchObject({ attemptLocalId: creationLocalId, content });
        if (!frozen) throw new Error('Expected original submitted content');
        repository = createDiscussionRepository({ scope, address: { serverId }, client });
        repository.adoptPendingIntent({ kind: 'create', ...intent, title: frozen.title!, content: frozen.content });
        await vi.waitFor(() => expect(repository.getSnapshot().mutations[creationLocalId]?.status,
            JSON.stringify({ committedRoot: network.messages[0]?.id, requests: homes.requests.map(row => row.path) })).toBe('observed_success'));
        expect(network.stored()?.discussion.creationLocalId).toBe(creationLocalId);
        expect(network.stored()?.discussion.anchor).toEqual({ kind: 'doc', doc: { ref: doc.value.ref, revision: passage.revision } });
        expect(network.messages).toHaveLength(1);
        await act(async () => { await draft.getCurrent().clearAfterObservedSuccess(submission!); });
        expect(draft.getCurrent().text).toBe('Newer unfinished question');
        const root = repository.getSnapshot().threads['committed-thread']?.messages[0];
        expect(root?.content).toEqual(content);
        expect(root?.replyTarget).toEqual({ kind: 'doc_passage', doc: { ref: doc.value.ref, revision: passage.revision } });
        if (!root) throw new Error('Expected reconciled committed root');
        const ref = root.messageRef;
        const route = buildDiscussionRouteHref({ target: { kind: 'discussion', address: ref.discussion,
            discussionId: ref.discussion.discussionId, messageId: ref.messageId } });
        const focus = { kind: 'discussion' as const, serverId: ref.discussion.serverId, id: ref.discussion.discussionId, messageId: ref.messageId };
        expect(resolveInboxItemPageRoute(readInboxItemFocus(createInboxItemRoute(focus).params.item)!)).toBe(route);
        const reopened = createDiscussionRepository({ scope, address: { serverId }, client });
        expect(await reopened.openMessage(ref)).toMatchObject({ messageRef: ref });
        expect(reopened.getSnapshot().threads[ref.discussion.discussionId]?.messages[0]?.messageRef).toEqual(ref);
        expect(DiscussionMessageContentV1StoredSchema.parse(reopened.getSnapshot().threads[ref.discussion.discussionId]?.messages[0]?.content)).toEqual(content);
        await reopened.post({ discussionId: ref.discussion.discussionId, localId: 'reply', content,
            replyTarget: { kind: 'message', messageId: ref.messageId }, draftSubmission: intent.draftSubmission });
        expect(network.messages[1]?.replyTarget).toEqual({ kind: 'message', messageId: ref.messageId });
        expect(network.messages[1]?.content).toEqual({ t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please review the second passage.' }] } });
        network.deny();
        await reopened.refreshDiscussion(ref.discussion.discussionId);
        expect(JSON.stringify(reopened.getSnapshot())).not.toContain(passage.quote);
        expect(homes.requestsFor('/v1/discussions').every(request => request.serverId === serverId)).toBe(true);
        await draft.unmount();
    });

    it.each(['denied', 'unavailable'] as const)('refuses a %s source without returning a committed payload or its quote', async state => {
        const serverId = await homes.addHome({ name: 'Unavailable', serverUrl: `https://${state}-doc.test`, accountId: 'alice', currentAccount: true });
        const status = state === 'denied' ? 404 : 503;
        homes.answer(serverId, '/v1/artifacts/missing', { status, body: { error: state === 'denied' ? 'not_found' : 'unavailable' } });
        homes.answer(serverId, 'POST /v1/discussions', { status: 409, body: { error: 'discussion_content_unavailable' } });
        const client = createArtifactActionsClient({ serverId, accountId: 'alice' });
        const target = captureDocPassageV1({ ref: { kind: 'doc', artifactId: 'missing', serverId },
            revision: { headerVersion: 1, bodyVersion: 1 }, source: 'Private retained quote', range: { start: 0, end: 22 } });
        const result = await client.replyToPassage({ target, localId: 'denied-comment', content: { v: 1, parts: [{ t: 'text', text: 'Review' }] } });
        expect(result).toEqual({ ok: false, failure: { code: 'discussion_content_unavailable' } });
        expect(JSON.stringify(result)).not.toContain(target.quote);
        expect('value' in result).toBe(false);
    });
});
