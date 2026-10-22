import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SessionDiscussionSourceLinksProvider } = await import('./SessionDiscussionSourceLinks');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');

afterEach(async () => { standardCleanup(); await homes.reset(); });

it('preserves transcript state when Discussion Account scope becomes available and unavailable', async () => {
    const serverUrl = 'https://discussion-source-continuity.test';
    const serverId = await homes.addHome({ name: 'Discussion Home', serverUrl, accountId: 'account-a' });
    homes.answer(serverId, 'GET /v1/discussions', { body: { discussions: [], nextCursor: null } });
    const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a', request: homes.request });
    onTestFinished(() => connection.dispose());
    function Transcript() {
        const [query, setQuery] = React.useState('');
        const { binding } = useServerCredentialAccountScopeBinding(serverId);
        return React.createElement('TranscriptProbe', { testID: 'transcript', query,
            current: binding?.isCurrent() === true, onSeed: () => setQuery('coastal sapphire') });
    }
    const frame = (home: string | null) => <SessionDiscussionSourceLinksProvider sessionId="session-a" serverId={home}>
        <Transcript />
    </SessionDiscussionSourceLinksProvider>;
    const screen = await renderScreen(frame(null));
    await act(async () => { screen.findByTestId('transcript')!.props.onSeed(); });
    expect(screen.findByTestId('transcript')!.props.query).toBe('coastal sapphire');
    await screen.update(frame(serverId));
    await vi.waitFor(() => expect(screen.findByTestId('transcript')!.props.current).toBe(true));
    await vi.waitFor(() => expect(homes.requests.some(request => request.path.startsWith('/v1/discussions'))).toBe(true));
    expect(screen.findByTestId('transcript')!.props.query).toBe('coastal sapphire');
    await screen.update(frame(null));
    expect(screen.findByTestId('transcript')!.props.query).toBe('coastal sapphire');
});
