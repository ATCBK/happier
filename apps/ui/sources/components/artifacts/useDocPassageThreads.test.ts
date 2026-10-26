import { act, createElement, Fragment, useMemo } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
// Native measurement/recycling is the boundary; the Discussion, shell, row adapter and cards stay real.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<typeof import('@legendapp/list/react-native')>(), memoizeItems: true }).module;
});
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
const { clearDiscussionRepositoryRegistryForTests, readRegisteredDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { useDocPassageThreads } = await import('./useDocPassageThreads');
const { useDocCollaboration } = await import('./useDocCollaboration');
const { ArtifactEditProposal } = await import('./ArtifactEditProposal');
const { ArtifactView } = await import('./ArtifactView');
const { DiscussionDetailsView } = await import('@/components/discussions/DiscussionDetailsView');
const { TranscriptListShell } = await import('@/components/sessions/transcript/viewport/shell/TranscriptListShell');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { createArtifactActionsClient } = await import('./artifactActionsClient');
const { createAccountArtifactStoredEnvelope } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
const { storage } = await import('@/sync/domains/state/storage');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

let previousProfileScope = storage.getState().profileScope;
let previousSettingsScope = storage.getState().settingsScope;
const previousPlatform = Platform.OS;
beforeEach(async () => { previousProfileScope = storage.getState().profileScope; previousSettingsScope = storage.getState().settingsScope; await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => { standardCleanup(); Object.defineProperty(Platform, 'OS', { configurable: true, value: previousPlatform }); storage.setState({ profileScope: previousProfileScope, settingsScope: previousSettingsScope }); clearDiscussionRepositoryRegistryForTests(); resetServerFeaturesClientForTests(); await homes.reset(); });

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
                ? { status: 409, body: { error: 'discussion_content_unavailable' } }
                : { body: { discussion: (entries.find(current => current.discussion.id === entry.discussion.id) ?? entry).discussion } } });
            homes.answer(serverId, `GET /v1/discussions/${entry.discussion.id}/messages`, { select: () => refused
                ? { status: 409, body: { error: 'discussion_content_unavailable' } }
                : { body: { messages: entry.discussion.id === stored.discussion.id ? network.messages : [entry.firstMessage], hasMoreOlder: false,
                    messageSeq: entry.discussion.id === stored.discussion.id ? network.messages.length : 1 } } });
        }
        const artifact = { id: 'doc-a', header: { title: 'Review' }, title: 'Review', body: 'Before', isDecrypted: true as const,
            ...doc.revision, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: 'alice', access: 'owner' as const,
            storageMode: 'plain' as const, publicAudience: 'none' as const };
        const hook = await renderHook(() => useDocCollaboration(artifact));
        await vi.waitFor(() => expect(hook.getCurrent()?.openCommentCount).toBe(initialThreads));
        await vi.waitFor(() => expect(hook.getCurrent()?.threads).toHaveLength(initialThreads));
        return { scope, hook, artifact, entries, second, network, client, refuse: (docToo = true) => {
            refused = true;
            if (docToo) homes.answer(serverId, 'GET /v1/artifacts/doc-a', { status: 409, body: { error: 'artifact_content_unavailable' } });
        } };
    }

    it('keeps this Doc read and projection idle for unrelated threads, while its root, replies and disposition remain live', async () => {
        const { scope, entries, second, network, client } = await mountedDoc(1);
        let renders = 0;
        let projections = 0;
        const probe = await renderHook(() => {
            renders += 1;
            const read = useDocPassageThreads({ serverId: scope.serverId, artifactId: 'doc-a', refreshKey: '1.1' });
            const projection = useMemo(() => { projections += 1; return read.threads.map(thread => thread.messages); }, [read]);
            return { read, projection };
        });
        await vi.waitFor(() => expect(probe.getCurrent().read.status).toBe('ready'));
        const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })!;
        const unrelated = { ...entries[0]!.discussion, id: 'unrelated-thread', anchor: null };
        homes.answer(scope.serverId, '/v1/discussions/unrelated-thread', { body: { discussion: unrelated } });
        homes.answer(scope.serverId, 'GET /v1/discussions/unrelated-thread/messages', { body: { messages: [], hasMoreOlder: false, messageSeq: 0 } });
        const before = { value: probe.getCurrent(), renders, projections };
        await act(async () => { await repository.refreshDiscussion('unrelated-thread'); });
        expect.soft(probe.getCurrent().read).toBe(before.value.read);
        expect.soft(probe.getCurrent().projection).toBe(before.value.projection);
        expect.soft(renders).toBe(before.renders);
        expect.soft(projections).toBe(before.projections);

        entries.push(second);
        await act(async () => { await repository.refreshDocList('doc-a'); });
        expect(probe.getCurrent().read).not.toBe(before.value.read);
        expect(probe.getCurrent().read.threads[1]?.messages[0]?.id).toBe('remote-root');
        const afterRoot = probe.getCurrent().read;
        await client.post({ discussionId: 'committed-thread', localId: 'local-reply', content: { v: 1, parts: [{ t: 'text', text: 'New reply' }] } });
        await act(async () => { await repository.refreshDiscussion('committed-thread'); });
        expect(probe.getCurrent().read).not.toBe(afterRoot);
        expect(JSON.stringify(probe.getCurrent().read)).toContain('New reply');
        const afterReply = probe.getCurrent().read;
        network.messages[0] = { ...network.messages[0]!, docEditProposalDispositionV1: { state: 'declined', decidedBy: { accountId: 'alice', atMs: 20 } } };
        entries[0]!.firstMessage = network.messages[0]!;
        await act(async () => { await repository.refreshDocList('doc-a'); });
        expect(probe.getCurrent().read).not.toBe(afterReply);
        expect(probe.getCurrent().read.threads[0]?.messages[0]?.docEditProposalDispositionV1?.state).toBe('declined');
    });

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

    it.each([false, true])('shares each shown Discussion proposal Doc read without mixing neighboring Docs, and refreshes revision and refused access (other Home focused: %s)', async (otherHomeFocused) => {
        const { scope, client, hook } = await mountedDoc(1);
        const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId })!;
        const root = repository.getSnapshot().threads['committed-thread']!.messages[0]!;
        if (!root.content || !('kind' in root.content) || root.content.kind !== 'doc_edit_proposal') throw new Error('Expected proposal');
        const proposal = root.content.proposal;
        await hook.unmount();
        expect((await client.post({ discussionId: 'committed-thread', localId: 'same-doc-proposal', content: root.content })).kind).toBe('succeeded');
        const stored = homes.artifacts(scope.serverId).read('doc-a')!;
        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, id: 'doc-b' });
        expect((await client.post({ discussionId: 'committed-thread', localId: 'other-doc-proposal', content: { kind: 'doc_edit_proposal',
            proposal: { ...proposal, target: { ...proposal.target, ref: { ...proposal.target.ref, artifactId: 'doc-b' } } } } })).kind).toBe('succeeded');
        const focusedScope = otherHomeFocused
            ? { serverId: await homes.addHome({ name: 'Another focused Home', serverUrl: 'https://other-discussion-home.test', accountId: 'brenda', currentAccount: true }), accountId: 'brenda' }
            : scope;
        await homes.selectHomes([focusedScope.serverId]);
        storage.setState(state => ({ profileScope: focusedScope, settingsScope: focusedScope,
            artifacts: Object.fromEntries(Object.entries(state.artifacts).filter(([id]) => id !== 'doc-a' && id !== 'doc-b')) }));
        const reads = (id: string) => homes.requests.filter(request => request.path === `/v1/artifacts/${id}`).length;
        const pages = (id: string) => homes.requests.filter(request => request.path.includes(`anchorDocArtifactId=${id}`)).length;
        const before = { a: reads('doc-a'), b: reads('doc-b'), countA: pages('doc-a'), countB: pages('doc-b') };
        const screen = await renderScreen(createElement(AppPaneProvider, null, createElement(DiscussionDetailsView, { target: { kind: 'discussion',
            address: { serverId: scope.serverId }, discussionId: 'committed-thread' }, active: true, standaloneSurface: true })));
        await vi.waitFor(() => expect(screen.findAllByType(ArtifactEditProposal)).toHaveLength(3));
        expect.soft(reads('doc-a') - before.a).toBe(0);
        expect.soft(reads('doc-b') - before.b).toBe(0);
        const shell = screen.findAllByType(TranscriptListShell)[0]!;
        const visible = shell.props.data.filter((item: { kind: string }) => item.kind === 'human_message')
            .map((item: unknown) => ({ isViewable: true, item }));
        await act(async () => shell.props.onViewableItemsChanged({ viewableItems: visible.slice(0, 2) }));
        await vi.waitFor(() => {
            expect(screen.findByTestId('discussion-proposal-committed-root.current')).not.toBeNull();
            expect(screen.findByTestId('discussion-proposal-committed-2.current')).not.toBeNull();
        });
        expect.soft(reads('doc-b') - before.b).toBe(0);
        await act(async () => shell.props.onViewableItemsChanged({ viewableItems: visible }));
        await vi.waitFor(() => {
            expect(screen.findByTestId('discussion-proposal-committed-3.current')).not.toBeNull();
        });
        expect.soft(reads('doc-a') - before.a).toBe(1);
        expect.soft(reads('doc-b') - before.b).toBe(1);
        expect.soft(pages('doc-a') - before.countA).toBe(1);
        expect.soft(pages('doc-b') - before.countB).toBe(1);

        homes.artifacts(scope.serverId).replaceStoredRow({ ...stored, bodyVersion: 2, updatedAt: 2 });
        await act(async () => publishHomeAccountChange(scope.serverId, ['doc-a'], { changeKinds: ['artifact'] }));
        await vi.waitFor(() => {
            expect(screen.findByTestId('discussion-proposal-committed-root.movedOn')).not.toBeNull();
            expect(screen.findByTestId('discussion-proposal-committed-2.movedOn')).not.toBeNull();
        });
        expect.soft(reads('doc-a') - before.a).toBe(2);
        expect.soft(reads('doc-b') - before.b).toBe(1);
        expect(screen.findByTestId('discussion-proposal-committed-3.current')).not.toBeNull();
        homes.answer(scope.serverId, 'GET /v1/artifacts/doc-a', { status: 403, body: { error: 'artifact_access_forbidden' } });
        await act(async () => publishHomeAccountChange(scope.serverId, ['doc-a'], { changeKinds: ['artifact'] }));
        await vi.waitFor(() => {
            const refused = screen.findAllByType(ArtifactEditProposal).filter(node => node.props.proposal.target.ref.artifactId === 'doc-a');
            expect(refused.map(node => node.props.docRead?.status)).toEqual(['unavailable', 'unavailable']);
            expect(screen.findByTestId('discussion-proposal-committed-root.movedOn')).toBeNull();
            expect(screen.findByTestId('discussion-proposal-committed-2.movedOn')).toBeNull();
            expect(reads('doc-a') - before.a).toBe(3);
        });
        expect(screen.findByTestId('discussion-proposal-committed-3.current')).not.toBeNull();
        expect(homes.requests.filter(request => /^\/v1\/artifacts\/doc-[ab]$/.test(request.path))
            .every(request => request.serverId === scope.serverId)).toBe(true);
        // An already-dispatched read belongs to the credential lifetime that admitted it.
        const late = createDeferred<void>();
        const entered = createDeferred<void>();
        homes.answer(scope.serverId, 'GET /v1/artifacts/doc-a', { select: () => {
            entered.resolve();
            return { respondAfter: late.promise, body: stored };
        } });
        await act(async () => publishHomeAccountChange(scope.serverId, ['doc-a'], { changeKinds: ['artifact'] }));
        await entered.promise;
        homes.answer(scope.serverId, '/v1/discussions/committed-thread', { status: 403, body: { error: 'discussion_access_forbidden' } });
        homes.answer(scope.serverId, 'GET /v1/discussions', { status: 403, body: { error: 'discussion_access_forbidden' } });
        await act(async () => { await homes.switchAccount(scope.serverId, 'bob', { currentAccount: true }); late.resolve(); });
        await vi.waitFor(() => expect(screen.findAllByType(ArtifactEditProposal)).toHaveLength(0));
        expect(screen.findByTestId('discussion-proposal-committed-root.current')).toBeNull();
    });

    it('retains readable Doc roots and the canonical count when only the thread title is unavailable', async () => {
        const { hook } = await mountedDoc(1, { unreadableTitle: true });
        expect(hook.getCurrent()?.threads).toHaveLength(1);
        expect(hook.getCurrent()?.openCommentCount).toBe(1);
    });

    it('establishes admitted zero after scoped discovery excludes an exactly refused root', async () => {
        const { scope, hook, refuse } = await mountedDoc(1);
        refuse(false);
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: 'committed-thread', changedAt: 2 }] }));
        await vi.waitFor(() => {
            expect(hook.getCurrent()?.openCommentCount).toBeNull();
            expect(hook.getCurrent()?.threads).toHaveLength(0);
        });
        // Exact denial proves withdrawal, not the complete Doc-scoped corpus.
        // Its authoritative null-root discovery can separately prove zero.
        await act(async () => publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 2, kind: 'artifact', entityId: 'doc-a', changedAt: 3 }] }));
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
