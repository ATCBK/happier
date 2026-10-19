import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
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

beforeEach(async () => { await homes.reset(); });
afterEach(async () => { standardCleanup(); clearDiscussionRepositoryRegistryForTests(); resetServerFeaturesClientForTests(); await homes.reset(); });

describe('Doc passage thread demand', () => {
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
        expect(hook.getCurrent().status).toBe('unavailable');
        expect(JSON.stringify(readRegisteredDiscussionRepository(scope, { serverId })!.getSnapshot())).not.toContain('Before');
        await hook.unmount();
        const reads = homes.requests.length;
        publishMountedDiscussionChanges({ ...scope,
            changes: [{ cursor: 3, kind: 'discussion', entityId: 'committed-thread', changedAt: 30 }] });
        expect(homes.requests).toHaveLength(reads);
    });
});
