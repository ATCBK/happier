import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { ActivityPersonalSessionMembershipProvider, useActivityPersonalSessionMembership } = await import('./activityPersonalSessionMembership');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const initial = getStorage().getState();
const mutePath = '/v2/account/session-delivery-mutes';
const serverUrl = 'https://activity-mute-demand.test';
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    await standardCleanup();
    await restored?.dispose();
    restored = undefined;
    getStorage().setState(initial, true);
});

async function prepare(enabled: boolean) {
    const serverId = await homes.addHome({ name: 'Activity', serverUrl, accountId: 'alice', currentAccount: true });
    homes.answer(serverId, '/v2/sessions/query', { body: { sessions: [], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: true, direct: false, team: false, group: false } });
    homes.answer(serverId, mutePath, { body: { scopes: [] } });
    const signals: (AbortSignal | null | undefined)[] = [];
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: async (url, init) => {
            if (new URL(String(url)).pathname === mutePath) signals.push(init?.signal);
            return homes.request(url, init);
        } });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const hook = await renderHook(() => useActivityPersonalSessionMembership(), {
        wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={enabled}>{children}</ActivityPersonalSessionMembershipProvider>,
    });
    const scopes = () => hook.getCurrent().accountDeliveryMutesByServerId?.[serverId]?.scopes;
    const reads = () => homes.requests.filter(request => request.serverId === serverId && request.path === mutePath).length;
    await vi.waitFor(() => expect(scopes()).toEqual([]));
    if (enabled) await vi.waitFor(() => expect(hook.getCurrent().followRulesByServerId?.[serverId]?.status).toBe('ready'));
    await flushHookEffects();
    return { serverId, hook, scopes, reads, signals };
}

it.each([false, true])('keeps unrelated arrivals at zero mute GETs and refreshes changed policy (Activity enabled: %s)', async enabled => {
    const { serverId, hook, scopes, reads } = await prepare(enabled);
    const baseline = reads();
    expect(baseline).toBe(1);
    await act(async () => {
        for (let index = 0; index < 1_000; index++) {
            // Known domain changes may be coarse: missing ids do not make a Machine or transcript a policy write.
            publishHomeAccountChange(serverId, undefined, { changeKinds: index % 2 ? ['machine'] : ['session'] });
        }
        publishHomeAccountChange(serverId, ['self'], { changeKinds: ['artifact'] });
        publishHomeAccountChange(serverId, ['other-account-setting'], { changeKinds: ['account'] });
        publishHomeAccountChange('another-home', [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] });
    });
    await flushHookEffects();
    expect(reads()).toBe(baseline);
    expect(scopes()).toEqual([]);

    const changes: Parameters<typeof publishHomeAccountChange>[] = [
        [serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }],
        [serverId, ['self'], { changeKinds: ['account'] }],
        [serverId, undefined, { changeKinds: ['account'] }],
        [serverId, ['unclassified-source']],
        [serverId, ['unclassified-source'], { source: 'connected', changeKinds: [] }],
        [serverId, ['access-changed'], { changeKinds: ['share'] }],
    ];
    for (const [index, change] of changes.entries()) {
        const next: FollowDeliveryMuteScopeV1[] = [{ kind: 'sender_session', sessionId: `sender-${index}` }];
        homes.answer(serverId, mutePath, { body: { scopes: next } });
        await act(async () => publishHomeAccountChange(...change));
        await vi.waitFor(() => expect(scopes()).toEqual(next));
        await flushHookEffects();
        expect(reads()).toBe(baseline + index + 1);
    }
    // A genuine refresh is unavailable until current authority has answered; errors never retain an unmuted snapshot.
    homes.answer(serverId, mutePath, { status: 503, body: { error: 'mute_state_unavailable' } });
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(reads()).toBe(baseline + changes.length + 1));
    await flushHookEffects();
    expect(hook.getCurrent().accountDeliveryMutesByServerId?.[serverId]).toBeNull();
});

it.each(['credentials', 'account'] as const)('withdraws an in-flight mute census on %s retirement', async retirement => {
    const { serverId, hook, scopes, reads, signals } = await prepare(false);
    const release = createDeferred<void>();
    homes.answer(serverId, mutePath, { body: { scopes: [{ kind: 'sender_session', sessionId: 'late-private-source' }] }, respondAfter: release.promise });
    const before = reads();
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    expect(hook.getCurrent().accountDeliveryMutesByServerId?.[serverId]).toBeNull();
    const pendingSignal = signals.at(-1);
    try {
        await act(async () => {
            if (retirement === 'credentials') await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId });
            else getStorage().getState().clearProfileScope();
        });
        await vi.waitFor(() => expect(pendingSignal?.aborted).toBe(true));
    } finally { await act(async () => release.resolve()); }
    await flushHookEffects();
    expect(scopes()).toBeUndefined();
    const after = reads();
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await flushHookEffects();
    expect(reads()).toBe(after);
    expect(scopes()).toBeUndefined();
});
