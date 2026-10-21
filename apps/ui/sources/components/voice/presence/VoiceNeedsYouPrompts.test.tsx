import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';

import { VoiceNeedsYouPrompts } from './VoiceNeedsYouPrompts';

// External enriched-markdown animation SDK: this context test uses plain, still tool text.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (input: { text: string; startOffset: number }) => [{ ...input, animated: false }],
}));
const sessionRpcTransport = vi.hoisted(() => vi.fn(async (_request: Readonly<{
    serverUrl: string | undefined; method: string; params: unknown;
}>) => undefined));
// Permission custody and the scoped Account/crypto reader remain real beneath
// the external Socket.IO acknowledgement boundary.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Expected Socket RPC request');
        if (!payload.method.endsWith(`:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`)) throw new Error('Unexpected request in Voice permission fixture');
        await sessionRpcTransport({ serverUrl, method: payload.method, params: payload.params });
        return { ok: true, result: undefined };
    });
});

const initialState = storage.getState();
let screen: RenderScreenResult | null = null;
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
beforeEach(async () => {
    const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    home = await serveSessionActionHome({
        homes: [{ key: 'session', serverUrl: 'https://session-actions.test', accountId: 'session-account', currentAccount: true }],
        route: request => sessionHttp.handle(request.url) ?? undefined,
    });
});
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await home.dispose();
    storage.setState(initialState);
});

describe('VoiceNeedsYouPrompts', () => {
    it.each([false, true])('answers the exact conversation independently of an unrelated surrounding transcript (%s)', async (surrounded) => {
        sessionRpcTransport.mockClear();
        const address = { serverId: getActiveServerSnapshot().serverId, sessionId: 'voice-needs-you' };
        const session = createSessionFixture({
            id: address.sessionId, serverId: address.serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1,
            agentState: { requests: { 'voice-request': { tool: 'Bash', arguments: { command: 'git status' }, createdAt: 1 } } },
        });
        // The real Session producer also materializes the server-scoped access row.
        storage.getState().applySessions([session]);
        storage.setState({ sessionMessages: { ...storage.getState().sessionMessages, [session.id]: createSessionMessagesFixture({ isLoaded: true }) } });

        const prompts = <VoiceNeedsYouPrompts address={address} testID="voice-pending" />;
        const unrelated = createReadOnlySessionTranscriptSource({ sessionId: 'other-session', messages: [], reducerState: null, metadata: null, agentState: null });
        screen = await renderScreen(surrounded ? <SessionTranscriptSourceProvider source={unrelated}>{prompts}</SessionTranscriptSourceProvider> : prompts);

        expect(screen.findByTestId('permission-prompt-card')).not.toBeNull();
        expect(screen.getTextContent()).toContain('git status');
        await screen.pressByTestIdAsync('permission-footer.allow');
        expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
            serverUrl: 'https://session-actions.test', method: `${address.sessionId}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
            params: { id: 'voice-request', approved: true },
        }));
    });
});
