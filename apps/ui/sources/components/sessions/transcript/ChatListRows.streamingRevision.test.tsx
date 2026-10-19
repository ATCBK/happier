/**
 * Streaming subscription contract: streaming deltas replace the message object,
 * mutate the containing maps in place, and bump `messageRevisionsById`. `useMessage`
 * must deliver the replacement to subscribed rows without any parent re-render.
 */
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { AgentTextMessage } from '@happier-dev/session-core/messages';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('useMessage subscription probe', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('re-reads a replaced message object on store notify', async () => {
        const storageModule = await import('@/sync/domains/state/storage');
        const store = (storageModule as unknown as { getStorage: () => { setState: (updater: unknown) => void } }).getStorage();
        const useMessage = (storageModule as unknown as { useMessage: (sessionId: string, messageId: string) => AgentTextMessage | null }).useMessage;

        const first: AgentTextMessage = {
            kind: 'agent-text', id: 'p1', localId: null, createdAt: 1, text: 'one', isThinking: false,
        };
        const entry = {
            messages: [first],
            messagesById: { p1: first } as Record<string, AgentTextMessage>,
            messagesMap: { p1: first } as Record<string, AgentTextMessage>,
            messageRevisionsById: { p1: 1 } as Record<string, number>,
            messagesVersion: 1,
        };
        await act(async () => {
            store.setState((state: Record<string, unknown>) => ({
                ...state,
                sessionMessages: { ...(state.sessionMessages as Record<string, unknown> ?? {}), sProbe: entry },
            }));
        });

        function Probe() {
            const message = useMessage('sProbe', 'p1');
            return React.createElement('Text', { testID: 'probe' }, message?.text ?? 'none');
        }
        const screen = await renderScreen(React.createElement(Probe));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.findByTestId('probe')?.props.children).toBe('one');

        await act(async () => {
            const next = { ...first, text: 'two' };
            entry.messagesById.p1 = next;
            entry.messagesMap.p1 = next;
            entry.messageRevisionsById.p1 = 2;
            store.setState((state: Record<string, unknown>) => ({ ...state }));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.findByTestId('probe')?.props.children).toBe('two');
    });
});
