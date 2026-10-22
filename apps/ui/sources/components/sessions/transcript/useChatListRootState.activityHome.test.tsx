import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createMachineFixture, renderScreen, renderHook, act } from '@/dev/testkit';
import { clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveExternalSessionOperationOriginAvailability } from '@/components/sessions/external/progress/externalSessionOperationProgressPresentation';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Session } from '@/sync/domains/state/storageTypes';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { storage } = await import('@/sync/domains/state/storage');
const { useChatListRootState } = await import('./useChatListRootState');
const { ChatListFooterWithKeyboardInset } = await import('./ChatListFrameSlots');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');
const { PluginContextualResourceStoreProvider } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');

function RootActivity(props: Readonly<{ session: Session }>) {
    const { internalProps } = useChatListRootState({ session: props.session, sessionSurfaceKey: 'legacy-activity' });
    return <ChatListFooterWithKeyboardInset sessionId={internalProps.sessionId}
        serverId={internalProps.sessionServerId} showToolCalls={false} />;
}

describe('transcript root activity Home', () => {
    it('keeps a retained operation origin unknown until its exact Home observes Machine presence again', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://operation-presence.test', accountId: 'operation-account' });
        const now = Date.now();
        const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: now });
        const session = createSessionFixture({ id: 'operation-session', serverId: account.home.id, metadata: {
            ...createSessionFixture().metadata!, externalSessionOperationPresentationV1: {
                v: 1, operationId: 'operation-1', revision: 1, kind: 'materialize', status: 'running', phase: 'importing',
            },
        } });
        storage.getState().applyMachines([machine], true, { sourceServerId: account.home.id });
        storage.getState().applySessions([session]);
        const hook = await renderHook(() => useChatListRootState({ session, sessionSurfaceKey: 'operation-presence' }), {
            wrapper: ({ children }) => <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={account.home.id} navigation="none">
                <PluginContextualResourceStoreProvider>{children}</PluginContextualResourceStoreProvider>
            </AppSessionTranscriptSourceProvider>,
        });
        const origin = () => {
            const target = hook.getCurrent().internalProps.externalSessionOperationOwnerTarget;
            expect(target).not.toBeNull();
            return resolveExternalSessionOperationOriginAvailability(target!);
        };
        try {
            expect(origin()).toBe('online');
            await act(async () => withdrawMachinePresenceForScope({ serverId: account.home.id, accountId: 'operation-account' }));
            expect(origin()).toBe('unknown');
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(now + 120_001);
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, active: false, activeAt: now + 1 }], false, { sourceServerId: account.home.id });
                captureMachinePresenceObservation({ serverId: account.home.id, accountId: 'operation-account' })([machine.id]);
            });
            expect(origin()).toBe('offline');
        } finally {
            await hook.unmount();
            clearMachineRequestReachabilityForTest();
            vi.useRealTimers();
            await account.dispose();
        }
    });
    it('carries the canonical unique Home for a legacy Session shell without borrowing an unknown Session', async () => {
        const account = await restoreServerAccountForTest({ serverUrl: 'https://legacy-transcript-activity.test' });
        // A running turn: the hidden-tools activity line exists only while work runs.
        const live = createSessionFixture({ id: 'legacy-activity-session', serverId: account.home.id,
            active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now(),
            latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now() });
        const legacyShell = { ...live, serverId: undefined };
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        const view = (session: Session) => <AppSessionTranscriptSourceProvider sessionId={session.id}
            serverId={account.home.id} navigation="none">
            <PluginContextualResourceStoreProvider><RootActivity session={session} /></PluginContextualResourceStoreProvider>
        </AppSessionTranscriptSourceProvider>;
        try {
            storage.getState().applySessions([live]);
            screen = await renderScreen(view(legacyShell));
            expect(screen.findByTestId('transcript-session-activity-status')).not.toBeNull();
            await screen.update(view({ ...legacyShell, id: 'unknown-session' }));
            expect(screen.findByTestId('transcript-session-activity-status')).toBeNull();
        } finally {
            await screen?.unmount();
            await account.dispose();
        }
    });
});
