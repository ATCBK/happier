import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const boundary = vi.hoisted(() => ({ router: null as ReturnType<typeof import('@/dev/testkit/mocks/router').createExpoRouterMock> | null }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    boundary.router = createExpoRouterMock();
    return boundary.router.module;
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { ChatListFooterWithKeyboardInset } = await import('./ChatListFrameSlots');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');

const reports = (total: number) => ({ total, working: total, needsYou: 0, stalled: 0, finished: 0, attentionPrimary: null });

describe('transcript Sessions chip', () => {
    it('shows the Session\'s own reports.total at the end of the transcript and opens the Agents destination; absent without children', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://transcript-reports.test', accountId: 'account-a' });
        const shell = createSessionFixture({ id: 'lead-session', serverId: account.home.id, managedSessions: reports(3) });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            storage.getState().applySessions([shell]);
            screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId={shell.id} serverId={shell.serverId ?? null}>
                <ChatListFooterWithKeyboardInset sessionId={shell.id} serverId={shell.serverId} />
            </AppSessionTranscriptSourceProvider>);
            expect(screen.findByTestId('transcript-session-reports-chip')).not.toBeNull();
            expect(screen.getTextContent()).toContain('Sessions · 3');

            await act(async () => screen!.pressByTestId('transcript-session-reports-chip'));
            const pushed = boundary.router!.spies.push.mock.calls.map(([href]) => JSON.stringify(href));
            expect(pushed).toHaveLength(1);
            expect(pushed[0]).toContain('lead-session');
            expect(pushed[0]).toContain('agents');

            await act(async () => { storage.getState().applySessions([{ ...shell, managedSessions: reports(4) }]); });
            expect(screen.getTextContent()).toContain('Sessions · 4');

            await act(async () => { storage.getState().applySessions([{ ...shell, managedSessions: reports(0) }]); });
            expect(screen.findByTestId('transcript-session-reports-chip')).toBeNull();
            await act(async () => { storage.getState().applySessions([{ ...shell, managedSessions: undefined }]); });
            expect(screen.findByTestId('transcript-session-reports-chip')).toBeNull();
        } finally {
            await screen?.unmount();
            await account.dispose();
        }
    });
});
