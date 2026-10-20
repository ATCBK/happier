import { act, createElement, Fragment } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
const { clearDiscussionRepositoryRegistryForTests, readRegisteredDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { useDocPassageThreads } = await import('./useDocPassageThreads');
const { useDocCollaboration } = await import('./useDocCollaboration');
const { ArtifactEditProposal } = await import('./ArtifactEditProposal');
const { ArtifactView } = await import('./ArtifactView');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { createAccountArtifactStoredEnvelope } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
const { storage } = await import('@/sync/domains/state/storage');

let previousProfileScope = storage.getState().profileScope;
const previousPlatform = Platform.OS;
beforeEach(async () => { previousProfileScope = storage.getState().profileScope; await homes.reset(); });
afterEach(async () => { standardCleanup(); Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform }); storage.setState({ profileScope: previousProfileScope }); clearDiscussionRepositoryRegistryForTests(); resetServerFeaturesClientForTests(); await homes.reset(); });

describe('Doc passage thread demand', () => {
    async function mountedDoc(initialThreads: number, options: { unreadableTitle?: boolean } = {}) {
        const serverId = await homes.addHome({ name: 'Subscribed Doc', serverUrl: 'https://subscribed-doc.test', accountId: 'alice', currentAccount: true });
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session', 'sessions.conversations'] as const) tryWriteServerEnabledBitInPlace(features, feature, true);
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId, accountId: 'alice' };
        storage.setState({ profileScope: scope });
        const doc = { ref: { kind: 'doc' as const, serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 } };
        const envelope = await createAccountArtifactStoredEnvelope({ mode: 'plain', header: { kind: 'artifact.legacy', title: 'Review' }, body: { body: 'Before' } });
        if (!envelope) throw new Error('Expected the real Plain Artifact codec');
        homes.artifacts(serverId).replaceStoredRow({ ...envelope, id: 'doc-a', encryptionMode: 'plain', ownerAccountId: 'alice', access: 'owner',
            publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        expect((await client.create({ title: 'Review', creationLocalId: 'remote-review', messageLocalId: 'remote-proposal',
            anchor: { kind: 'doc', doc }, replyTarget: { kind: 'doc_passage', doc }, content: { kind: 'doc_edit_proposal', proposal: {
                target: { ...doc, range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: doc.revision,
                before: 'Before', after: 'After', reason: 'Review' } } })).kind).toBe('succeeded');
        const stored = network.stored()!;
        const second = { ...stored, discussion: { ...stored.discussion, id: 'remote-thread', creationLocalId: 'remote-second',
            latestMessage: { ...stored.discussion.latestMessage, id: 'remote-root' } },
            firstMessage: { ...stored.firstMessage, id: 'remote-root', discussionId: 'remote-thread', localId: 'remote-second-root' } };
        const entries = [stored, second].slice(0, initialThreads);
        let refused = false;
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
            const url = new URL(request.url);
            return { body: { discussions: entries.filter(entry => (url.searchParams.get('state') === 'archived') === (entry.discussion.archivedAt !== null))
                .filter(entry => !url.searchParams.has('anchorDocArtifactId') || (entry.discussion.anchor?.kind === 'doc'
                    && entry.discussion.anchor.doc.ref.artifactId === url.searchParams.get('anchorDocArtifactId')))
                .map(entry => ({ ...entry.discussion, ...(options.unreadableTitle ? { titleContent: { t: 'plain', v: { invalidTitle: true } } } : {}), ...(url.searchParams.has('anchorDocArtifactId')
                    ? { firstMessage: refused ? null : entry.firstMessage } : {}) })), nextCursor: null } };
        } });
        for (const entry of [stored, second]) {
            homes.answer(serverId, `/v1/discussions/${entry.discussion.id}`, { select: () => refused
                ? { status: 409, body: { error: 'discussion_content_unavailable' } } : { body: { discussion: entry.discussion } } });
            homes.answer(serverId, `GET /v1/discussions/${entry.discussion.id}/messages`, { select: () => refused
                ? { status: 409, body: { error: 'discussion_content_unavailable' } }
                : { body: { messages: [entry.firstMessage], hasMoreOlder: false, messageSeq: 1 } } });
        }
        const artifact = { id: 'doc-a', header: { title: 'Review' }, title: 'Review', body: 'Before', isDecrypted: true as const,
            ...doc.revision, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'alice', access: 'owner' as const,
            storageMode: 'plain' as const, publicAudience: 'none' as const };
        const hook = await renderHook(() => useDocCollaboration(artifact));
        await vi.waitFor(() => expect(hook.getCurrent()?.openCommentCount).toBe(initialThreads));
        await vi.waitFor(() => expect(hook.getCurrent()?.threads).toHaveLength(initialThreads));
        return { scope, hook, artifact, entries, second, refuse: (docToo = true) => {
            refused = true;
            if (docToo) homes.answer(serverId, 'GET /v1/artifacts/doc-a', { status: 409, body: { error: 'artifact_content_unavailable' } });
        } };
    }

    it('updates membership and the admitted count after remote create/archive on the same mounted Doc, with refusal unknown', async () => {
        const { scope, hook, entries, second, refuse } = await mountedDoc(1);
        entries.push(second);
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'remote-thread', changedAt: 2 }] }));
        await vi.waitFor(() => {
            expect(hook.getCurrent()?.threads).toHaveLength(2);
            expect(hook.getCurrent()?.openCommentCount).toBe(2);
        });
        entries[0] = { ...entries[0]!, discussion: { ...entries[0]!.discussion, archivedAt: 3 } };
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'discussion', entityId: 'committed-thread', changedAt: 3 }] }));
        await vi.waitFor(() => {
            expect(hook.getCurrent()?.threads.map(thread => thread.id)).toEqual(['remote-thread']);
            expect(hook.getCurrent()?.openCommentCount).toBe(1);
        });
        refuse();
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 3, kind: 'artifact', entityId: 'doc-a', changedAt: 4 }] }));
        await vi.waitFor(() => {
            expect(hook.getCurrent()?.openCommentCount).toBeNull();
            expect(hook.getCurrent()?.threads).toHaveLength(0);
        });
    });

    it('does not hydrate closed-margin threads or repeat the Doc count enumeration for each mounted proposal card', async () => {
        const { hook } = await mountedDoc(2);
        expect.soft(homes.requests.filter(request => /\/v1\/discussions\/[^/]+\/messages/.test(request.path))).toHaveLength(0);
        const artifactReads = () => homes.requests.filter(request => request.path === '/v1/artifacts/doc-a');
        const beforeCards = artifactReads().length;
        const countPages = () => homes.requests.filter(request => request.path.includes('anchorDocArtifactId=doc-a'));
        expect(countPages()).toHaveLength(2);
        const screen = await renderScreen(createElement(Fragment, null,
            ...hook.getCurrent()!.threads.map(thread => hook.getCurrent()!.margin.renderCard(thread.id))));
        await vi.waitFor(() => expect(screen.findByTestId('artifact:passage-thread:remote-thread.proposal.current')).not.toBeNull());
        expect(artifactReads()).toHaveLength(beforeCards);
        expect(countPages()).toHaveLength(2);
        expect(homes.requests.filter(request => /\/v1\/discussions\/[^/]+\/messages/.test(request.path))).toHaveLength(2);
    });

    it('retains readable Doc roots and the canonical count when only the thread title is unavailable', async () => {
        const { hook } = await mountedDoc(1, { unreadableTitle: true });
        expect(hook.getCurrent()?.threads).toHaveLength(1);
        expect(hook.getCurrent()?.openCommentCount).toBe(1);
    });

    it('excludes known inaccessible roots without turning an admitted zero count into unknown', async () => {
        const { scope, hook, refuse } = await mountedDoc(1);
        refuse(false);
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 2 }] }));
        await vi.waitFor(() => {
            expect(hook.getCurrent()?.openCommentCount).toBe(0);
            expect(hook.getCurrent()?.threads).toHaveLength(0);
        });
    });

    it('opens the same existing Doc thread menu for an ambiguous native passage tap', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const { scope, artifact } = await mountedDoc(2);
        const screen = await renderScreen(createElement(ArtifactView, { artifactId: artifact.id, artifact, presentation: 'page' }));
        const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'artifact:comments.menu')!;
        await vi.waitFor(() => expect(menu()?.props.items).toHaveLength(2));
        const trigger = screen.findAllByType('Pressable').find(node => String(node.props.testID ?? '').startsWith('markdown-source-range-trigger') && !node.props.disabled)!;
        expect(trigger).toBeDefined();
        expect(menu().props.open).toBe(false);
        await act(async () => trigger.props.onPress());
        expect(menu().props.open).toBe(true);
        const stored = homes.artifacts(scope.serverId).read(artifact.id)!;
        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, id: 'other-doc' });
        await act(async () => screen.update(createElement(ArtifactView, { artifactId: 'other-doc', artifact: { ...artifact, id: 'other-doc' }, presentation: 'page' })));
        expect(menu().props.open).toBe(false);
        await act(async () => screen.update(createElement(ArtifactView, { artifactId: artifact.id, artifact, presentation: 'page' })));
        await vi.waitFor(() => expect(menu().props.items).toHaveLength(2));
        expect(menu().props.open).toBe(false);
    });

    it('does not fall back to per-card reads for loading or unavailable parent admission, while standalone proposals still admit their source', async () => {
        const { scope } = await mountedDoc(1);
        const root = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })!.getSnapshot().threads['committed-thread']!.messages[0]!;
        if (!root.content || !('kind' in root.content) || root.content.kind !== 'doc_edit_proposal') throw new Error('Expected the opened proposal root');
        const props = { client: createArtifactActionsClient(scope), proposalRef: root.messageRef, proposal: root.content.proposal,
            disposition: root.docEditProposalDispositionV1, viewerAccountId: 'alice', resolveAccountLabel: () => null };
        const sourceReads = () => homes.requests.filter(request => request.path === '/v1/artifacts/doc-a').length;
        const countPages = () => homes.requests.filter(request => request.path.includes('anchorDocArtifactId=doc-a')).length;
        const before = { reads: sourceReads(), pages: countPages() };
        for (const status of ['loading', 'unavailable'] as const) {
            const screen = await renderScreen(createElement(ArtifactEditProposal, { ...props, docRead: { status } }));
            expect(screen.findByTestId('artifact-edit-proposal.current')).toBeNull();
            expect(sourceReads()).toBe(before.reads);
            expect(countPages()).toBe(before.pages);
            await screen.unmount();
        }
        const standalone = await renderScreen(createElement(ArtifactEditProposal, props));
        await vi.waitFor(() => expect(standalone.findByTestId('artifact-edit-proposal.current')).not.toBeNull());
        expect(sourceReads()).toBe(before.reads + 1);
        expect(countPages()).toBe(before.pages + 1);
    });

    it.each([{ rootOutsideTail: false, delayInitial: false, refusal: 'thread' }, { rootOutsideTail: true, delayInitial: false, refusal: 'thread' },
        { rootOutsideTail: true, delayInitial: true, refusal: 'thread' },
        { rootOutsideTail: true, delayInitial: false, refusal: 'list' },
        { rootOutsideTail: true, delayInitial: false, refusal: 'null' }])('reconciles a root proposal without reviving refused source ($rootOutsideTail/$delayInitial/$refusal)', async ({ rootOutsideTail, delayInitial, refusal }) => {
        const serverId = await homes.addHome({ name: 'Doc margin', serverUrl: 'https://doc-margin-changes.test', accountId: 'alice', currentAccount: true });
        const features = createRootLayoutFeaturesResponse();
        for (const feature of ['sharing.session', 'sessions.conversations'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, feature, true)).toBe(true);
        }
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const scope = { serverId, accountId: 'alice' };
        const doc = { ref: { kind: 'doc' as const, serverId, artifactId: 'doc-a' }, revision: { headerVersion: 1, bodyVersion: 1 } };
        const network = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        const created = await client.create({ title: 'Review', creationLocalId: 'margin-review', messageLocalId: 'margin-proposal',
            anchor: { kind: 'doc', doc }, content: { kind: 'doc_edit_proposal', proposal: {
                target: { ...doc, range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: doc.revision,
                before: 'Before', after: 'After', reason: 'Review' } } });
        expect(created.kind).toBe('succeeded');
        await client.post({ discussionId: 'committed-thread', localId: 'later-2', content: { v: 1, parts: [{ t: 'text', text: 'Later reply' }] } });
        await client.post({ discussionId: 'committed-thread', localId: 'later-3', content: { v: 1, parts: [{ t: 'text', text: 'Latest reply' }] } });
        let refused = false;
        const initialList = createDeferred<void>();
        const initialEntered = createDeferred<void>();
        const summary = () => {
            const row = network.stored()!.discussion;
            const latest = network.messages.at(-1)!;
            return { ...row, messageSeq: latest.seq, latestMessage: { ...row.latestMessage,
                id: latest.id, localId: latest.localId, seq: latest.seq, createdAt: latest.createdAt } };
        };
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
            const url = new URL(request.url);
            if (refused && refusal === 'list') return { status: 403, body: { error: 'discussion_access_forbidden' } };
            if (delayInitial && url.searchParams.has('anchorDocArtifactId')) initialEntered.resolve();
            return { ...(delayInitial && url.searchParams.has('anchorDocArtifactId') ? { respondAfter: initialList.promise } : {}),
                body: { discussions: url.searchParams.get('state') === 'archived' ? []
                : [{ ...summary(), ...(url.searchParams.has('anchorDocArtifactId') ? { firstMessage: refused && refusal === 'null' ? null : network.messages[0] } : {}) }], nextCursor: null } };
        } });
        homes.answer(serverId, '/v1/discussions/committed-thread', { select: () => refused
            ? { status: 409, body: { error: 'discussion_content_unavailable' } } : { body: { discussion: summary() } } });
        homes.answer(serverId, 'GET /v1/discussions/committed-thread/messages', { select: (_input, request) => {
            if (refused) return { status: 409, body: { error: 'discussion_content_unavailable' } };
            const url = new URL(request.url);
            const after = url.searchParams.get('afterSeq');
            const before = url.searchParams.get('beforeSeq');
            const messages = after !== null ? network.messages.filter(row => row.seq > Number(after)).slice(0, 2)
                : network.messages.filter(row => before === null || row.seq < Number(before)).slice(rootOutsideTail ? -2 : 0);
            return { body: { messages, hasMoreOlder: (messages[0]?.seq ?? 1) > 1, messageSeq: network.messages.length } };
        } });
        const hook = await renderHook((refreshKey: string) => useDocPassageThreads({ serverId, artifactId: 'doc-a', refreshKey }), { initialProps: '1' });
        if (delayInitial) {
            await initialEntered.promise;
            const repository = readRegisteredDiscussionRepository(scope, { serverId })!;
            expect(repository.getSnapshot().threads['committed-thread']).toBeUndefined();
            refused = true;
            await act(async () => { await repository.refreshDiscussion('committed-thread'); initialList.resolve(); });
            await vi.waitFor(() => {
                expect(hook.getCurrent().status).toBe('unavailable');
                expect(JSON.stringify(hook.getCurrent())).not.toContain('Before');
            });
            expect(repository.getSnapshot().threads['committed-thread']).toMatchObject({ summary: null, messages: [] });
            expect(JSON.stringify(repository.getSnapshot())).not.toContain('Before');
            return;
        }
        await vi.waitFor(() => expect(hook.getCurrent().threads[0]?.messages[0]?.docEditProposalDispositionV1?.state).toBe('open'));
        let releaseThread: () => void = () => {};
        await act(async () => { releaseThread = hook.getCurrent().mountThread('committed-thread'); });
        await vi.waitFor(() => expect(readRegisteredDiscussionRepository(scope, { serverId })!.getSnapshot().threads['committed-thread']?.status).toBe('ready'));
        network.messages[0] = { ...network.messages[0]!, docEditProposalDispositionV1: {
            state: 'declined', decidedBy: { accountId: 'alice', atMs: 10 } } };
        await act(async () => { publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 10 }] }); });
        await vi.waitFor(() => expect(hook.getCurrent().threads[0]?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined'));
        expect(hook.getCurrent().threads[0]?.summary.firstMessage?.docEditProposalDispositionV1?.state).toBe('declined');
        refused = true;
        if (refusal === 'thread') await act(async () => { publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 2, kind: 'discussion', entityId: 'committed-thread', changedAt: 20 }] }); });
        else await hook.rerender('2');
        await vi.waitFor(() => expect(JSON.stringify(hook.getCurrent())).not.toContain('Before'));
        expect(JSON.stringify(hook.getCurrent())).not.toContain('After');
        expect(hook.getCurrent().status).toBe(refusal === 'null' ? 'ready' : 'unavailable');
        expect(JSON.stringify(readRegisteredDiscussionRepository(scope, { serverId })!.getSnapshot())).not.toContain('Before');
        releaseThread();
        await hook.unmount();
        const reads = homes.requests.length;
        publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 3, kind: 'discussion', entityId: 'committed-thread', changedAt: 30 }] });
        expect(homes.requests).toHaveLength(reads);
    });
});
