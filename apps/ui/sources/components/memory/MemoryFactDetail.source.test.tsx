import * as React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { MemoryFactV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { MemoryFactDetail } = await import('./MemoryFactDetail');
const { getStorage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const initial = getStorage().getState();
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Source', serverUrl: 'https://memory-source.test', accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { conversations: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
});

it('loads a Discussion source title from the shared authorized Discussion reader', async () => {
    const row = DiscussionSummaryV1Schema.parse({
        id: 'source-discussion', ownerAccountId: 'alice', encryptionMode: 'plain', anchor: null, access: 'owner',
        keyReadiness: true, dataEncryptionKey: null, creationLocalId: null,
        titleContent: { t: 'plain', v: { v: 1, title: 'Decision discussion' } },
        latestMessage: { id: 'committed-message', localId: null, seq: 1, authorAccountId: 'alice',
            accountActor: { v: 1, accountId: 'alice', profile: null }, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0,
        recentAuthorAccountIds: ['alice'], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    });
    homes.answer(serverId, '/v1/discussions', { body: { discussions: [], nextCursor: null } });
    homes.answer(serverId, '/v1/discussions/source-discussion', { body: { discussion: row } });
    homes.answer(serverId, '/v1/discussions/source-discussion/messages', { body: { messages: [], hasMoreOlder: false, messageSeq: 1 } });
    const fact: MemoryFactV1 = { ...decision(), decision: { reason: 'Keep the source clear', approvedBy: null,
        sourceMessageRef: { kind: 'discussion', discussion: { serverId, discussionId: row.id }, messageId: 'committed-message' } } };
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('fact.source')?.props.detail).toBe('Decision discussion'));
});
afterEach(() => { standardCleanup(); getStorage().setState(initial, true); });

function decision(): MemoryFactV1 {
    return { id: 'fact', text: 'Use the scoped reader', createdAtMs: 1, sourceSessionRef: null,
        decision: { reason: 'Keep the source clear', approvedBy: null,
            sourceMessageRef: { kind: 'session', session: { serverId, sessionId: 'source-session' }, messageId: 'committed-message' } } };
}

it('loads the exact decision Session title without loading its transcript or a Machine', async () => {
    const session = createSessionFixture({ id: 'source-session', metadata: { path: '/project', host: 'host', summary: { text: 'Scoped source title', updatedAt: 1 } } });
    homes.answer(serverId, '/v2/sessions/source-session', { body: createPlainSessionByIdResponseFixture(session) });
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={decision()} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('fact.source')?.props.detail).toBe('Scoped source title'));
    expect(homes.requests.some(request => request.path.includes('/messages') || request.path.startsWith('/v1/machines'))).toBe(false);
});

it('does not use a different legacy Session as the decision source when the real source is denied', async () => {
    const legacy = createSessionFixture({ id: 'legacy-session', metadata: { path: '/project', host: 'host', summary: { text: 'Unrelated legacy title', updatedAt: 1 } } });
    getStorage().getState().applySessions([legacy]);
    homes.answer(serverId, '/v2/sessions/source-session', { status: 403, body: { error: 'forbidden' } });
    const fact = { ...decision(), sourceSessionRef: { serverId, sessionId: legacy.id } };
    const screen = await renderScreen(<MemoryFactDetail testID="fact" fact={fact} documentRef={null} serverId={serverId} viewerAccountId="alice" archived={false} />);
    await waitForHomeGovernance(() => expect(homes.requests.some(request => request.path === '/v2/sessions/source-session')).toBe(true));
    expect(screen.findByTestId('fact.source')?.props.detail).not.toBe('Unrelated legacy title');
});
