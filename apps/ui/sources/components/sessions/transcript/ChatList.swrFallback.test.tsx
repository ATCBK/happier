import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { storage } from '@/sync/domains/state/storageStore';
import type { AgentTextMessage } from "@happier-dev/session-core/messages";
import { AppSessionTranscriptSourceProvider } from './source/appSessionTranscriptSource';
import { readSessionMessagesSnapshot } from '@/sync/store/sessionMessagesSnapshot';
import { isEnrichedMarkdownRuntimePreloaded } from '@/components/markdown/enriched/preloadEnrichedMarkdownRuntime';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    return (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({ original }).module;
});

// The installed SDK is the boundary; preload dedupe, readiness and retry stay real.
const preloadMarkdownRuntimeSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react-native-enriched-markdown', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-enriched-markdown')>(),
    preloadMarkdownRuntime: preloadMarkdownRuntimeSpy,
}));

const { ChatList } = await import('./ChatList');
const cachedMessage: AgentTextMessage = {
    kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hello',
};
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
let previousState = storage.getState();

beforeEach(async () => {
    previousState = storage.getState();
    home = await serveSessionActionHome();
    const session = createSessionFixture({ id: 'session-1', serverId: home.serverId, active: true });
    storage.setState({
        sessions: { [session.id]: session },
        sessionMessages: { [session.id]: createSessionMessagesFixture({
            messageIdsOldestFirst: [cachedMessage.id], messagesById: { [cachedMessage.id]: cachedMessage }, isLoaded: true,
        }) },
        settings: { ...storage.getState().settings, transcriptGroupingMode: 'linear', transcriptGroupToolCalls: false },
    });
    const transcript = storage.getState().sessionMessages[session.id]!;
    // The real ordered-snapshot reader owns SWR continuity. Model the prior
    // loaded reader, rather than manufacturing its cached array in a hook mock.
    readSessionMessagesSnapshot(session.id, transcript.messageIdsOldestFirst,
        transcript.messagesById, transcript.messagesVersion, transcript.isLoaded);
    preloadMarkdownRuntimeSpy.mockClear();
});

afterEach(async () => {
    await standardCleanup();
    await home.dispose();
    storage.setState(previousState, true);
});

function renderTranscript() {
    const session = storage.getState().sessions['session-1']!;
    return renderScreen(
        <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={home.serverId}>
            <ChatList session={session} sessionSurfaceKey={JSON.stringify([home.serverId, session.id])} />
        </AppSessionTranscriptSourceProvider>,
    );
}

function expectCachedRow(screen: Awaited<ReturnType<typeof renderScreen>>) {
    expect(screen.findByType('LegendList').props.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'message', messageId: cachedMessage.id }),
    ]));
    expect(screen.getTextContent()).toContain(cachedMessage.text);
}

describe('ChatList (SWR fallback)', () => {

    it('preloads the SDK on an empty transcript mount before a Markdown row can request it', async () => {
        storage.getState().evictSessionMessages('session-1');
        storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: true }) } });
        expect(isEnrichedMarkdownRuntimePreloaded()).toBe(false);
        await renderTranscript();
        await vi.waitFor(() => {
            expect(preloadMarkdownRuntimeSpy).toHaveBeenCalledOnce();
            expect(isEnrichedMarkdownRuntimePreloaded()).toBe(true);
        });
    });

    it('uses the SWR messages array when transcript ids are empty during a refresh', async () => {
        const screen = await renderTranscript();
        expectCachedRow(screen);
        await act(async () => {
            storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: false }) } });
        });
        expectCachedRow(screen);
    });

    it('uses retained messages when transcript ids are empty but the transcript is marked loaded', async () => {
        storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({
            messagesById: { [cachedMessage.id]: cachedMessage }, isLoaded: true,
        }) } });
        const screen = await renderTranscript();
        expectCachedRow(screen);
    });

    it('clears retained rows when the refresh settles with an empty transcript', async () => {
        const screen = await renderTranscript();
        expectCachedRow(screen);
        await act(async () => {
            storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: false }) } });
        });
        expectCachedRow(screen);
        await act(async () => {
            storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: true }) } });
        });
        expect(screen.findByType('LegendList').props.data).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'message', messageId: cachedMessage.id }),
        ]));
        expect(screen.getTextContent()).not.toContain(cachedMessage.text);
    });

    it('retires retained content on an Account switch and displays the new Account\'s messages', async () => {
        const screen = await renderTranscript();
        expectCachedRow(screen);
        await act(async () => {
            await home.switchAccount('session', 'next-account');
            storage.setState({
                sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId: home.serverId, active: true }) },
                sessionMessages: { 'session-1': createSessionMessagesFixture({ isLoaded: false }) },
            });
        });
        expect(screen.findByType('LegendList').props.data).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'message', messageId: cachedMessage.id }),
        ]));
        expect(screen.getTextContent()).not.toContain(cachedMessage.text);
        const replacement: AgentTextMessage = { ...cachedMessage, id: 'next-message', text: 'replacement answer' };
        await act(async () => {
            storage.setState({ sessionMessages: { 'session-1': createSessionMessagesFixture({
                messageIdsOldestFirst: [replacement.id], messagesById: { [replacement.id]: replacement }, isLoaded: true,
            }) } });
        });
        expect(screen.getTextContent()).toContain(replacement.text);
        expect(screen.getTextContent()).not.toContain(cachedMessage.text);
    });
});
