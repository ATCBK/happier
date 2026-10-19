import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { ListSessionFollowSourcesResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { useSessionTalkTargets } = await import('./sessionTalkTargets');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const initial = getStorage().getState();
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    standardCleanup();
    await restored?.dispose(); restored = undefined;
    getStorage().setState(initial, true);
});

it('demands authorized targets only while open and retains incomplete refreshes as partial, never empty', async () => {
    const serverUrl = 'https://talk-picker.test';
    const serverId = await homes.addHome({ name: 'Picker', serverUrl, accountId: 'alice', currentAccount: true });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {} });
    const source = createSessionFixture({ id: 'source', serverId, encryptionMode: 'plain',
        manager: { sessionId: 'unloaded-manager' }, access: createSessionAccessFixture('view') });
    homes.answer(serverId, '/v2/sessions/source', { body: createPlainSessionByIdResponseFixture(source) });
    homes.answer(serverId, '/v2/sessions/source/follows/followers', { body: {
        follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: 4,
    } });
    const following = resolveSessionFollowActionRequest('follow.list', { direction: 'following', receiver: { kind: 'session', sessionId: 'source' } });
    homes.answer(serverId, following.path, { body: ListSessionFollowSourcesResponseSchema.parse({ sources: [] }) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { body: { sessions: [],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null } });
    const closed = await renderHook(({ enabled, sessionId = 'source' }: { enabled: boolean; sessionId?: string }) => useSessionTalkTargets(sessionId, serverId, { enabled }),
        { initialProps: { enabled: false } });
    const before = homes.requests.length;
    expect(closed.getCurrent().manager.coverage).toBe('unavailable');
    expect(closed.getCurrent().manager.loading).toBe(false);
    await closed.rerender({ enabled: false });
    expect(homes.requests).toHaveLength(before);
    await closed.rerender({ enabled: true });
    await vi.waitFor(() => expect(closed.getCurrent().manager.coverage).toBe('complete'));
    expect(closed.getCurrent().manager.addresses).toEqual([{ serverId, sessionId: 'unloaded-manager' }]);
    expect(closed.getCurrent().manager.names).toHaveLength(1);
    expect(closed.getCurrent().manager.names[0]).not.toBe('unloaded-manager');
    expect(closed.getCurrent().matching).toMatchObject({ coverage: 'unavailable', error: 'selection_required', loading: false });
    expect(closed.getCurrent().discussion).toMatchObject({ coverage: 'unavailable', error: 'selection_required', loading: false });
    await vi.waitFor(() => expect(closed.getCurrent().followers.coverage).toBe('complete'));
    expect(closed.getCurrent().followers.addresses).toEqual([]);
    await vi.waitFor(() => expect(['manager', 'workers', 'siblings', 'followers', 'following'].every(selector =>
        !closed.getCurrent()[selector as 'manager'].loading)).toBe(true));
    const afterRead = homes.requests.length;
    await act(async () => publishHomeAccountChange(serverId, ['source'], { changeKinds: ['session'], sessionListQueryAffects: false }));
    await flushHookEffects();
    expect(homes.requests).toHaveLength(afterRead);
    homes.answer(serverId, '/v2/sessions/source', { status: 503, body: { error: 'unavailable' } });
    await act(async () => closed.getCurrent().refresh());
    await vi.waitFor(() => expect(closed.getCurrent().manager).toMatchObject({
        coverage: 'partial', loading: false, error: 'session_target_unavailable',
        addresses: [{ serverId, sessionId: 'unloaded-manager' }],
    }));
    await closed.rerender({ enabled: false });
    expect(closed.getCurrent().manager).toMatchObject({ coverage: 'unavailable', addresses: [], loading: false });
    await closed.rerender({ enabled: true, sessionId: 'another-source' });
    expect(closed.getCurrent().manager.addresses).toEqual([]);
});
