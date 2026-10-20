import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFindSeedHandoff, openChatWithFindSeed } from './fileFindSeedHandoff';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createDeferred } from '@/dev/testkit';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import type { UnsavedChangesDecision } from '@/utils/ui/promptUnsavedChangesAlert';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getStorage } = await import('@/sync/domains/state/storage');
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
beforeEach(async () => {
    await homes.addHome({ name: 'Native History Home', serverUrl: 'https://native-history-home.test', accountId: 'account', serverIdentityId: 'srv_native_history_test' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://native-history-home.test', accountId: 'account', serverIdentityId: 'srv_native_history_test', request: homes.request });
    serverId = resolveServerProfileScopeIdForIdentifier(connection.home.id);
    getStorage().setState({ profileScope: { serverId, accountId: 'account' } });
});
afterEach(async () => {
    clearActiveUnsavedChangesGuard();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    getStorage().setState(initialState, true);
});

describe('native History launch input at the chat handoff owner', () => {
    it('does not publish a query from an Account retired while its navigation decision was pending', async () => {
        const handoff = createFileFindSeedHandoff();
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        const decision = createDeferred<UnsavedChangesDecision>();
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: () => decision.promise,
            tag: 'native-find-retirement' });
        const open = vi.fn();
        const opening = openChatWithFindSeed({ handoff, authority,
            destination: { sessionId: 'retired-launch', serverId },
            seed: { query: 'private retired query', options: { matchCase: false, regex: false },
                target: { kind: 'route-message-id', routeMessageId: 'row' } },
            open,
        });
        await connection?.dispose();
        connection = undefined;
        decision.resolve('discard');
        await opening;
        expect(open).not.toHaveBeenCalled();
        expect(handoff.peekChatCurrent({ sessionId: 'retired-launch', serverId })).toBeNull();
        handoff.dispose();
    });
    it('keeps the native query when reopening an existing Session through its local Home alias', async () => {
        const handoff = createFileFindSeedHandoff();
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        const seed = { query: 'violet harbor lantern', target: { kind: 'native-message' as const,
            agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'matched-item' } };
        const open = vi.fn();
        expect(connection!.home.id).not.toBe(serverId);
        // Routes retain the device-local profile id; credential custody uses the
        // portable Home identity. Both identify this same restored Home.
        await openChatWithFindSeed({ handoff,
            destination: { sessionId: 'already-linked', serverId: connection!.home.id },
            seed, authority, open });
        expect(open).toHaveBeenCalledOnce();
        expect(handoff.takeChatCurrent({ sessionId: 'already-linked', serverId })?.seed).toMatchObject({
            query: seed.query, target: { kind: 'route-message-id', routeMessageId:
                `server:${makeExternalSessionHistoricalImportLocalId({ agentId: 'claude', remoteSessionId: 'native', directItemId: 'matched-item' })}` },
        });
        handoff.dispose();
    });
    it('normalizes native identity once and retains the incumbent one-shot Account retirement contract', async () => {
        const handoff = createFileFindSeedHandoff();
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        const destination = { sessionId: 'linked', serverId, accountId: 'account' };
        const seed = { query: 'needle', target: { kind: 'native-message' as const,
            agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'item' } };
        handoff.stageChat(destination, seed, authority);
        expect(handoff.takeChatCurrent(destination)?.seed).toEqual({ query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: `server:${makeExternalSessionHistoricalImportLocalId({
                agentId: 'claude', remoteSessionId: 'native', directItemId: 'item' })}` } });
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.stageChat(destination, seed, authority);
        await connection?.dispose();
        connection = undefined;
        expect(authority.isCurrent()).toBe(false);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://native-history-home.test', accountId: 'account', request: homes.request });
        getStorage().setState({ profileScope: { serverId, accountId: 'account' } });
        const nextAuthority = captureActiveServerAccountScopeLifetime();
        if (!nextAuthority) throw new Error('Expected restored Account lifetime');
        expect(authority.isCurrent()).toBe(false);
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        // A delayed old-Account result cannot repopulate the reconnected destination.
        handoff.stageChat(destination, seed, authority);
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        const cancel = handoff.stageChat(destination, seed, nextAuthority);
        cancel();
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.stageChat({ ...destination, accountId: 'another-account' }, seed, nextAuthority);
        expect(handoff.takeChatCurrent(destination)).toBeNull();
        handoff.dispose();
    });
});
