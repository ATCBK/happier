import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionHumanPresenceViewerV1Schema } from '@happier-dev/protocol/sessions';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { sessionHumanPresenceStore } from './sessionHumanPresenceStore';
import { useDiscussionHumanPresence, useSessionHumanPresence } from './useSessionHumanPresence';

const initialStorage = storage.getState();
const initialAppliedHome = getAppliedActiveServerSnapshot();
const initialAvailability = isAppliedActiveServerRuntimeAvailable();
const cleanup: (() => void)[] = [];
afterEach(() => {
    standardCleanup();
    cleanup.splice(0).reverse().forEach(dispose => dispose());
    storage.setState(initialStorage, true);
    publishAppliedActiveServerSnapshot(initialAppliedHome, initialAvailability);
});

const viewer = (accountId: string) => SessionHumanPresenceViewerV1Schema.parse({
    account: { kind: 'account', accountId, firstName: accountId, lastName: null, username: null, avatarUrl: null }, typing: true,
});

describe('human presence hooks', () => {
    it('reads a standalone Discussion and retires its observation before another Account can replace the Home', async () => {
        const target = { serverId: 'presence-hook-home', discussionId: 'same-id' };
        storage.getState().activateProfileScope({ serverId: target.serverId, accountId: 'account-a' });
        publishAppliedActiveServerSnapshot({ serverId: target.serverId, serverUrl: 'https://presence-hook.test', generation: 1 });
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        const first = sessionHumanPresenceStore.attachHome(target.serverId, 'account-a');
        cleanup.push(first.dispose);
        first.beginDeclaration([], [{ discussionId: target.discussionId }]);
        first.confirmDeclaration([], [{ discussionId: target.discussionId }]);
        const hook = await renderHook(({ lifetime }: { lifetime: ServerAccountScopeLifetime }) => useDiscussionHumanPresence(target, lifetime), {
            initialProps: { lifetime },
        });
        await act(async () => first.receiveSnapshot({ v: 1, discussionId: target.discussionId, observedAt: 1, viewers: [viewer('peer-a')] }));
        expect(hook.getCurrent()).toMatchObject({ status: 'live', viewers: [{ account: { accountId: 'peer-a' } }] });
        await act(async () => storage.getState().activateProfileScope({ serverId: target.serverId, accountId: 'account-b' }));
        expect(lifetime.isCurrent()).toBe(false);
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', viewers: [] });
        const next = sessionHumanPresenceStore.attachHome(target.serverId, 'account-b');
        cleanup.push(next.dispose);
        next.beginDeclaration([], [{ discussionId: target.discussionId }]);
        next.confirmDeclaration([], [{ discussionId: target.discussionId }]);
        await act(async () => next.receiveSnapshot({ v: 1, discussionId: target.discussionId, observedAt: 2, viewers: [viewer('peer-b')] }));
        expect(hook.getCurrent().viewers).toEqual([]);
        await hook.rerender({ lifetime: captureActiveServerAccountScopeLifetime()! });
        expect(hook.getCurrent()).toMatchObject({ status: 'live', viewers: [{ account: { accountId: 'peer-b' } }] });
    });

    it('preserves the Session-only hook and keeps a same-ID Discussion separate', async () => {
        const address = { serverId: 'session-hook-home', sessionId: 'same-id' };
        const home = sessionHumanPresenceStore.attachHome(address.serverId, 'self');
        cleanup.push(home.dispose);
        home.beginDeclaration([address.sessionId], [{ discussionId: address.sessionId }]);
        home.confirmDeclaration([address.sessionId], [{ discussionId: address.sessionId }]);
        const hook = await renderHook(() => useSessionHumanPresence(address));
        await act(async () => home.receiveSnapshot({ v: 1, discussionId: address.sessionId, observedAt: 1, viewers: [viewer('discussion-peer')] }));
        expect(hook.getCurrent().viewers).toEqual([]);
        await act(async () => home.receiveSnapshot({ v: 1, sessionId: address.sessionId, observedAt: 2, viewers: [viewer('session-peer')] }));
        expect(hook.getCurrent()).toMatchObject({ status: 'live', viewers: [{ account: { accountId: 'session-peer' } }] });
    });
});
