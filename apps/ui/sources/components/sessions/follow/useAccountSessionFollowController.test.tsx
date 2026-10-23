import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

// Only HTTP, Socket.IO and device credential storage are substituted by this testkit.
const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { setServerReachabilityNetworkAllowed } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { useAccountSessionFollowController } = await import('./useAccountSessionFollowController');
const before = storage.getState();

afterEach(async () => {
    await standardCleanup();
    storage.setState(before, true);
    setServerReachabilityNetworkAllowed(true);
    network.resetRequests();
});
afterAll(() => network.dispose());

it('keeps one personal Follow read across 1,000 unrelated changes while refreshing exact and private Follow facts', async () => {
    const home = await network.addHome('https://personal-follow-demand.test', 'follow-account');
    setActiveServerId(home.id);
    publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 });
    storage.setState(state => ({ profileScope: { serverId: home.id, accountId: home.accountId },
        profile: { ...state.profile, id: home.accountId } }));
    setServerReachabilityNetworkAllowed(true);
    const sessionId = 'shown-session';
    const path = `/v2/sessions/${sessionId}/follow`;
    let notificationLevel: 'important' | 'none' = 'important';
    network.setHttpResponder(async input => new URL(String(input)).pathname === path ? Response.json({
        follow: { sessionId, following: true, notificationLevel, includeInVoice: false },
        isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false,
    }) : null);
    const hook = await renderHook(() => useAccountSessionFollowController({ serverId: home.id, sessionId }, true));
    await vi.waitFor(() => expect(hook.getCurrent().state.projection?.follow?.notificationLevel).toBe('important'));
    const reads = () => network.httpRequests.filter(request => new URL(request.url).pathname === path).length;
    expect(reads()).toBe(1);
    await act(async () => {
        for (let index = 0; index < 1_000; index += 1) {
            publishHomeAccountChange(home.id, [`other-${index}`], { changeKinds: [index % 2 ? 'session' : 'artifact'] });
        }
        publishHomeAccountChange('another-home', [sessionId], { changeKinds: ['session'] });
    });
    await flushHookEffects();
    expect(reads()).toBe(1);

    notificationLevel = 'none';
    const relevant = [
        { entityIds: [sessionId], changeKinds: ['session'] as const },
        // A manager/access change for this source still invalidates its current Follow facts.
        { entityIds: [sessionId], changeKinds: ['share'] as const },
        { entityIds: [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], changeKinds: ['account'] as const },
        { entityIds: ['self'], changeKinds: ['account'] as const },
        {}, // Reconnect/unknown wakes remain conservative.
    ];
    for (const [index, event] of relevant.entries()) {
        await act(async () => { publishHomeAccountChange(home.id, event.entityIds, event); });
        await vi.waitFor(() => expect(reads()).toBe(index + 2));
        await flushHookEffects();
    }
    expect(hook.getCurrent().state.projection?.follow?.notificationLevel).toBe('none');
    await hook.unmount();
    publishHomeAccountChange(home.id);
    await flushHookEffects();
    expect(reads()).toBe(6);
});
