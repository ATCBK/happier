import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { VoiceSessionEndedAttempt } from '@/voice/session/voiceSessionStore';

const { VoiceEndedPendingApproval } = await import('./VoiceEndedPendingApproval');
import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';

/**
 * After End, a request the ended conversation left waiting is surfaced from the attempt's captured
 * addresses only — never for another Account, never from a control id — and Review opens that exact
 * session, where the real card decides it by a tap. Ending decided nothing.
 */

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async (original) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
const initialStorageState = getStorage().getState();
let home: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
let TARGET = { serverId: '', sessionId: 'coding-session' };
let CARRIER = { serverId: '', sessionId: 'voice-carrier' };
let ACCOUNT = { serverId: '', accountId: 'account-1' };

function pendingSession(id: string): Session {
    return createSessionFixture({
        id,
        serverId: ACCOUNT.serverId,
        active: true,
        presence: 'online',
        updatedAt: 10,
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: 9,
        agentState: {
            controlledByUser: null,
            requests: { 'request-1': { tool: 'Bash', kind: 'permission', arguments: { command: 'git status' }, createdAt: 1 } },
            completedRequests: {},
        },
    });
}

function ended(overrides: Partial<VoiceSessionEndedAttempt> = {}): VoiceSessionEndedAttempt {
    return {
        sessionId: 'control-1',
        adapterId: 'test.adapter',
        startedAt: 1,
        endedAt: 2,
        reason: { kind: 'stopped' },
        conversationSessionAddress: CARRIER,
        targetSessionAddress: TARGET,
        transcriptMode: 'synthetic',
        accountScope: ACCOUNT,
        conversationScope: { kind: 'voice_home' },
        ...overrides,
    };
}

let screen: RenderScreenResult | null = null;
beforeEach(async () => {
    getStorage().setState(initialStorageState, true);
    // Real Home, Account lifetime and scoped Session readers; only the HTTP and
    // Socket transports are synthetic beneath the canonical family fixture.
    home = await serveAccountHomes({ homes: [{ key: 'ended', serverUrl: 'https://voice-ended-review.test',
        accountId: 'account-1', currentAccount: true }], route: () => undefined });
    disconnect = await home.restoreActiveConnection();
    const serverId = home.homes.ended!.id;
    ACCOUNT = { serverId, accountId: 'account-1' };
    TARGET = { serverId, sessionId: 'coding-session' };
    CARRIER = { serverId, sessionId: 'voice-carrier' };
    getStorage().setState({ sessions: { [TARGET.sessionId]: pendingSession(TARGET.sessionId) } });
    routerPush.mockReset();
});
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    standardCleanup();
    await disconnect?.();
    disconnect = undefined;
    await home.dispose();
    getStorage().setState(initialStorageState, true);
});

async function render(value: VoiceSessionEndedAttempt) {
    screen = await renderScreen(<VoiceEndedPendingApproval ended={value} testID="pending" />);
    return screen;
}

describe('VoiceEndedPendingApproval', () => {
    it('opens post-End Review in the hosting workspace at the captured Home and Session', async () => {
        function HostedReview() {
            const [destination, setDestination] = React.useState('/settings/voice');
            const navigation = React.useMemo<DestinationNavigation>(() => ({
                push: (href) => setDestination(String(href)),
                replace: (href) => setDestination(String(href)),
                back: () => setDestination('/settings/voice'),
            }), []);
            return <DestinationInstanceHost tabId="voice-ended-tab" ref={{ kind: 'voice', params: {} }}
                pathname={destination} focused visible navigation={navigation}>
                {destination === '/settings/voice' ? <VoiceEndedPendingApproval ended={ended()} testID="pending" />
                    : <Text testID="pending-open-destination">{destination}</Text>}
            </DestinationInstanceHost>;
        }
        screen = await renderScreen(<HostedReview />);
        await screen.pressByTestIdAsync('pending.review');
        expect(screen.findByTestId('pending-open-destination')?.props.children)
            .toBe(`/session/coding-session?serverId=${encodeURIComponent(TARGET.serverId)}`);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('keeps a request the ended conversation left waiting reachable at its exact session', async () => {
        const view = await render(ended());
        view.pressByTestId('pending.review');
        expect(routerPush).toHaveBeenCalledTimes(1);
        expect(String(routerPush.mock.calls[0]![0])).toContain(TARGET.sessionId);
    });

    it('shows nothing for an ended attempt of another Account', async () => {
        const view = await render(ended({ accountScope: { ...ACCOUNT, accountId: 'account-2' } }));
        expect(view.findByTestId('pending.review')).toBeNull();
    });

    it('never falls back to the control id when the attempt captured no address', async () => {
        getStorage().setState({ sessions: { 'control-1': pendingSession('control-1') } });
        const view = await render(ended({ conversationSessionAddress: null, targetSessionAddress: null }));
        expect(view.findByTestId('pending.review')).toBeNull();
    });

    it('stays quiet when nothing is waiting', async () => {
        getStorage().setState({ sessions: { [TARGET.sessionId]: createSessionFixture({ id: TARGET.sessionId, serverId: TARGET.serverId }) } });
        const view = await render(ended());
        expect(view.findByTestId('pending.review')).toBeNull();
    });
});
