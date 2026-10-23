import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { ListSessionFollowSourcesResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

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
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: createSessionReadBatchFetchBoundary(homes.request) });
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
    await act(async () => {
        for (let index = 0; index < 1_000; index++) {
            publishHomeAccountChange(serverId, [`unrelated-key-${index}`], { changeKinds: ['kv'], sessionListQueryAffects: false });
        }
    });
    await flushHookEffects();
    expect(homes.requests.length - afterRead).toBe(0);
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

it('keeps unrelated selector previews and reads stable while Matching changes', async () => {
    const serverUrl = 'https://talk-picker-filter.test';
    const serverId = await homes.addHome({ name: 'Filter picker', serverUrl, accountId: 'alice', currentAccount: true });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {} });
    const source = createSessionFixture({ id: 'source', serverId, encryptionMode: 'plain',
        manager: { sessionId: 'unloaded-manager' }, access: createSessionAccessFixture('view') });
    homes.answer(serverId, '/v2/sessions/source', { body: createPlainSessionByIdResponseFixture(source) });
    const followersPath = '/v2/sessions/source/follows/followers';
    homes.answer(serverId, followersPath, { body: { follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: 0 } });
    const following = resolveSessionFollowActionRequest('follow.list', { direction: 'following', receiver: { kind: 'session', sessionId: 'source' } });
    homes.answer(serverId, following.path, { body: ListSessionFollowSourcesResponseSchema.parse({ sources: [] }) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { body: { sessions: [],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null } });
    const matchingFilter = normalizeSessionListFilterV1({ homeServerIds: [serverId],
        startedBy: ['you', 'agents', 'triggers'], scope: 'all_accessible' });
    const hook = await renderHook(({ filter }) => useSessionTalkTargets('source', serverId, { matchingFilter: filter }),
        { initialProps: { filter: matchingFilter } });
    const unrelated = ['manager', 'workers', 'siblings', 'followers', 'following'] as const;
    await vi.waitFor(() => expect([...unrelated, 'matching' as const].every(selector =>
        hook.getCurrent()[selector].coverage === 'complete' && !hook.getCurrent()[selector].loading)).toBe(true));
    const managerAddresses = hook.getCurrent().manager.addresses;
    const before = homes.requests.length;
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    homes.answer(serverId, followersPath, { respondAfter: pending,
        body: { follows: [], sources: [], rules: [], coverage: 'complete', peopleCount: 0 } });
    homes.answer(serverId, following.path, { respondAfter: pending,
        body: ListSessionFollowSourcesResponseSchema.parse({ sources: [] }) });
    try {
        await hook.rerender({ filter: { ...matchingFilter, source: 'persisted' } });
        for (const selector of unrelated) expect(hook.getCurrent()[selector], selector).toMatchObject({ coverage: 'complete', loading: false });
        expect(hook.getCurrent().manager.addresses).toBe(managerAddresses);
    } finally { release?.(); }
    await vi.waitFor(() => expect(hook.getCurrent().matching.loading).toBe(false));
    expect(hook.getCurrent().matching.coverage).toBe('complete');
    const rereads = homes.requests.slice(before);
    expect(rereads.filter(request => request.path === followersPath || request.path === following.path)).toEqual([]);
    expect(hook.getCurrent().manager.addresses).toBe(managerAddresses);
});
