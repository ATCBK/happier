import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFindSeedHandoff } from './fileFindSeedHandoff';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

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
    serverId = await homes.addHome({ name: 'Native History Home', serverUrl: 'https://native-history-home.test', accountId: 'account' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://native-history-home.test', accountId: 'account', request: homes.request });
    getStorage().setState({ profileScope: { serverId, accountId: 'account' } });
});
afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    getStorage().setState(initialState, true);
});

describe('native History launch input at the chat handoff owner', () => {
    it('normalizes native identity once and retains the incumbent one-shot Account retirement contract', async () => {
        const handoff = createFileFindSeedHandoff();
        const authority = captureActiveServerAccountScopeLifetime();
        if (!authority) throw new Error('Expected real Account lifetime');
        const destination = { sessionId: 'linked', serverId, accountId: 'account' };
        const seed = { query: 'needle', target: { kind: 'native-message' as const,
            agentId: 'claude', remoteSessionId: 'native', sourceItemId: 'item' } };
        handoff.stageChat(destination, seed, authority);
        expect(handoff.takeChatCurrent(destination)?.seed).toEqual({ query: 'needle', options: { matchCase: false, regex: false },
            target: { kind: 'route-message-id', routeMessageId: makeExternalSessionHistoricalImportLocalId({
                agentId: 'claude', remoteSessionId: 'native', directItemId: 'item' }) } });
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
