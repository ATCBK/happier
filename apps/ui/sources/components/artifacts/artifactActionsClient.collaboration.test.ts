import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import type { DiscussionDraftSubmission } from '@/sync/ops/discussions/discussionRepository';
import { captureDocPassageV1 } from '@happier-dev/protocol/artifacts/artifactPassageV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { deriveDocCommentDiscussionCreationLocalIdV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DiscussionMessageContentV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';

const route = vi.hoisted(() => ({ params: {} as Record<string, string | string[] | undefined> }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/discussions/new', params: () => route.params,
}).module);
// This native SDK is imported by route siblings, but a new-draft route never renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown rendering is outside the new-draft route'); },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { ArtifactPassageQuote } = await import('./ArtifactPassageQuote');
const { DiscussionRouteScreen } = await import('@/components/discussions/DiscussionRouteScreen');
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { createDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepository');
const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { useDiscussionDraft } = await import('@/components/discussions/useDiscussionDraft');
const { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeDiscussionSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { buildDiscussionRouteHref, readDiscussionRouteDraftId } = await import('@/components/discussions/discussionRoutes');
const { createInboxItemRoute, readInboxItemFocus, resolveInboxItemPageRoute } = await import('@/components/inbox/inboxItemFocus');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');

beforeEach(async () => { route.params = {}; await homes.reset(); });
afterEach(async () => { clearDiscussionRepositoryRegistryForTests(); resetSessionDraftRepositoryForTests(); standardCleanup(); await homes.reset(); });

describe('Doc collaboration data through the real Actions and Discussion repository', () => {
    it('mounts the keyed New Discussion rather than the unrelated singleton draft', async () => {
        const serverId = await homes.addHome({ name: 'Draft Route Home', serverUrl: 'https://doc-passage-draft-route.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session', 'sessions.conversations'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, feature, true)) throw new Error(`Unable to enable ${feature}`);
        }
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        const artifacts = createArtifactActionsClient(scope);
        const passage = captureDocPassageV1({ ref: { kind: 'doc', serverId, artifactId: 'notes' },
            revision: { headerVersion: 1, bodyVersion: 2 }, source: 'Private passage.', range: { start: 0, end: 16 } });
        const href = new URL(artifacts.beginPassageComment(passage), 'https://home.invalid');
        const nextHref = new URL(artifacts.beginPassageComment({ ...passage, revision: { ...passage.revision, bodyVersion: 3 } }), 'https://home.invalid');
        const draftId = readDiscussionRouteDraftId(href.searchParams.get('draftId') ?? undefined);
        const nextDraftId = readDiscussionRouteDraftId(nextHref.searchParams.get('draftId') ?? undefined);
        if (!draftId || !nextDraftId) throw new Error('Expected keyed passage routes');
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion' }, patch: { title: 'Unrelated N2 title', text: 'Unrelated N2 text' } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion', draftId }, patch: { title: 'Passage title', text: 'Passage question' } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion', draftId: nextDraftId }, patch: { title: 'Next passage title', text: 'Next passage question' } });
        answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        route.params = Object.fromEntries(href.searchParams.entries());
        const screen = await renderScreen(createElement(DiscussionRouteScreen, { kind: 'new' }));
        await vi.waitFor(() => expect(screen.findByTestId('session-discussion-title')?.props.value, screen.getTextContent()).toBe('Passage title'));
        const unrelated = await renderHook(() => useDiscussionDraft({ scope, address: { kind: 'newDiscussion' } }));
        let submission: DiscussionDraftSubmission | undefined;
        act(() => { submission = unrelated.getCurrent().captureSubmittedCurrentness({ kind: 'create',
            creationLocalId: 'unrelated-create', messageLocalId: 'unrelated-message' }); });
        const repository = getDiscussionRepository({ scope, address: { serverId }, client: createDiscussionClient({ scope, availability: 'available' }) });
        await act(async () => { repository.adoptPendingIntent({ kind: 'create', creationLocalId: 'unrelated-create',
            messageLocalId: 'unrelated-message', title: 'Unrelated N2 title', content: { v: 1, parts: [{ t: 'text', text: 'Unrelated N2 text' }] },
            draftSubmission: submission! }); });
        expect(screen.findByTestId('session-discussion-new-empty')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Unrelated N2 text');
        route.params = Object.fromEntries(nextHref.searchParams.entries());
        await screen.update(createElement(DiscussionRouteScreen, { kind: 'new' }));
        expect(screen.findByTestId('session-discussion-title')?.props.value).toBe('Next passage title');
        expect(screen.findByTestId('session-discussion-new-empty')).not.toBeNull();
        route.params = { ...route.params, draftId: 'unsupported-key' };
        await screen.update(createElement(DiscussionRouteScreen, { kind: 'new' }));
        expect(screen.findByTestId('session-discussion-new-details')).toBeNull();
        await unrelated.unmount();
        await screen.unmount();
    });
    it('isolates passage drafts from the singleton and other passages while reopening the same retained passage', async () => {
        const serverId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://doc-passage-drafts.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const client = createArtifactActionsClient(scope);
        const passage = captureDocPassageV1({ ref: { kind: 'doc', serverId, artifactId: 'notes' },
            revision: { headerVersion: 1, bodyVersion: 2 }, source: 'Private first. Private second.', range: { start: 0, end: 14 } });
        const unrelated = captureDocPassageV1({ ref: { ...passage.ref, artifactId: 'unrelated' }, revision: passage.revision,
            source: 'Unrelated private source', range: { start: 0, end: 24 } });
        writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion' }, patch: { title: 'Unrelated draft', text: 'N2 retained text', passage: unrelated } });
        const readAddress = (href: string) => {
            const url = new URL(href, 'https://home.invalid');
            const draftId = readDiscussionRouteDraftId(url.searchParams.get('draftId') ?? undefined);
            expect(draftId).toEqual(expect.any(String));
            if (!draftId) throw new Error('Expected qualified passage draft');
            return { kind: 'newDiscussion' as const, draftId };
        };
        const href = client.beginPassageComment(passage);
        expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.document)
            .toMatchObject({ title: { value: 'Unrelated draft' }, composer: { text: { value: 'N2 retained text' } } });
        expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.document).toMatchObject({ passage: { value: unrelated } });
        const address = readAddress(href);
        const hook = await renderHook(() => useDiscussionDraft({ scope, address }));
        expect(hook.getCurrent().passage).toEqual(passage);
        await act(async () => hook.getCurrent().setText('Retained passage question'));
        await hook.unmount();
        expect(client.beginPassageComment({ ...passage, prefix: 'changed context', suffix: 'still private' })).toBe(href);
        const restored = await renderHook(() => useDiscussionDraft({ scope, address: readAddress(href) }));
        expect(restored.getCurrent().text).toBe('Retained passage question');
        const different = captureDocPassageV1({ ref: passage.ref, revision: passage.revision,
            source: 'Private first. Private second.', range: { start: 15, end: 30 } });
        for (const next of [different, { ...passage, ref: { ...passage.ref, artifactId: 'other-notes' } },
            { ...passage, revision: { ...passage.revision, headerVersion: 2 } },
            { ...passage, revision: { ...passage.revision, bodyVersion: 3 } }]) {
            const nextAddress = readAddress(client.beginPassageComment(next));
            expect(nextAddress).not.toEqual(address);
            expect(getSessionDraftSnapshot(scope, nextAddress)?.document).toMatchObject({ composer: { text: { value: '' } } });
        }
        expect(href).not.toContain(passage.quote);
        expect(href).not.toContain('Private');
        await restored.unmount();
    });
    it('refuses initial participants at the Doc-comment delegation before writing and preserves participant-free comments', async () => {
        const serverId = await homes.addHome({ name: 'Saved Doc', serverUrl: 'https://doc-comment-audience.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const artifacts = createArtifactActionsClient(scope);
        const source = 'Review this passage.';
        const created = await artifacts.createArtifact({ header: { kind: 'artifact.legacy', title: 'Notes' }, body: source });
        if (!('ok' in created) || !created.ok) throw new Error('Expected source Doc');
        const doc = await artifacts.readDoc({ ref: { kind: 'doc', serverId, artifactId: created.value.artifactId } });
        if (!doc.ok) throw new Error('Expected readable source Doc');
        const passage = captureDocPassageV1({ ref: doc.value.ref, revision: doc.value.artifact.revision, source,
            range: { start: 0, end: source.length } });
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        const messageLocalId = 'comment-audience';
        const input = { creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({ ref: doc.value.ref, localId: messageLocalId }),
            messageLocalId, title: 'Comment', content: { kind: 'doc_passage_comment' as const, passage,
                content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Please review.' }] } } };
        expect(await client.create({ ...input, participants: [{ kind: 'session',
            sessionId: { selector: 'discussion', discussionId: 'reviewers' } }] }))
            .toEqual({ kind: 'failed', errorCode: 'invalid_parameters' });
        expect(network.messages).toHaveLength(0);
        expect(homes.requestsFor('/v1/discussions').filter(request => request.input && typeof request.input === 'object'
            && 'firstMessage' in request.input)).toHaveLength(0);
        expect(await client.create(input)).toMatchObject({ kind: 'succeeded' });
        expect(network.messages).toHaveLength(1);
    });

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
        const newRoute = new URL(artifacts.beginPassageComment(passage), 'https://home.invalid');
        const draftId = readDiscussionRouteDraftId(newRoute.searchParams.get('draftId') ?? undefined);
        if (!draftId) throw new Error('Expected qualified passage draft');
        const draftAddress = { kind: 'newDiscussion' as const, draftId };
        expect(newRoute.searchParams.get('serverId')).toBe(serverId);
        let draft = await renderHook(() => useDiscussionDraft({ scope, address: draftAddress }));
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
        draft = await renderHook(() => useDiscussionDraft({ scope, address: draftAddress }));
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
