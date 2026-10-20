import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message, ToolCallMessage } from '@happier-dev/session-core/messages';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionCompletedBrowserActionKey } from './hooks';
import type { SessionMessages } from './domains/messages';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

afterEach(async () => {
    await standardCleanup();
    actionOperationStore.reset();
});

describe('useSessionCompletedBrowserActionKey', () => {
    it('refreshes after the exact Browser open operation settles without another transcript completion', async () => {
        const scope = { serverId: 'browser-home', accountId: 'browser-account', machineId: 'browser-machine' };
        const running = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'browser-open', revision: 1,
            actionId: 'browser.view.open', state: 'running', title: 'Open Browser', createdAt: 1, startedAt: 2,
            scope: { accountId: scope.accountId, machineId: scope.machineId, sessionId: 'browser-signal' },
            cancellation: 'unsupported' });
        actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [running] });
        let renders = 0;
        const options = { operationScope: scope };
        const hook = await renderHook(() => { renders++; return useSessionCompletedBrowserActionKey('browser-signal', options); });
        const before = hook.getCurrent();
        const initialRenders = renders;
        await act(async () => {
            actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [{ ...running,
                operationId: 'other-home', state: 'succeeded', revision: 2, settledAt: 3 }] });
            actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [
                { ...running, operationId: 'other-account', state: 'succeeded', revision: 2, settledAt: 3,
                    scope: { ...running.scope, accountId: 'other-account' } },
                { ...running, operationId: 'other-machine', state: 'succeeded', revision: 2, settledAt: 3,
                    scope: { ...running.scope, machineId: 'other-machine' } },
                { ...running, operationId: 'other-session', state: 'succeeded', revision: 2, settledAt: 3,
                    scope: { ...running.scope, sessionId: 'other-session' } },
                { ...running, operationId: 'other-action', actionId: 'browser.automation.snapshot',
                    state: 'succeeded', revision: 2, settledAt: 3 },
                { ...running, revision: 2, progress: { kind: 'phase', phase: 'browser_runtime_provisioning', label: 'Preparing Browser' } },
            ] });
        });
        expect(hook.getCurrent()).toBe(before);
        expect(renders).toBe(initialRenders);
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [{
            ...running, state: 'succeeded', revision: 3, settledAt: 4,
        }] }));
        expect(hook.getCurrent()).not.toBe(before);
        const completedKey = hook.getCurrent();
        const completedRenders = renders;
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [{
            ...running, state: 'succeeded', revision: 4, settledAt: 4, title: 'Opened Browser',
        }] }));
        expect(hook.getCurrent()).toBe(completedKey);
        expect(renders).toBe(completedRenders);
        await hook.unmount();
    });

    it.each([
        { operationScope: null },
        { operationScope: { serverId: null, accountId: 'browser-account', machineId: 'browser-machine' } },
        { operationScope: { serverId: 'browser-home', accountId: null, machineId: 'browser-machine' } },
        { operationScope: { serverId: 'browser-home', accountId: 'browser-account', machineId: null } },
        { enabled: false, operationScope: { serverId: 'browser-home', accountId: 'browser-account', machineId: 'browser-machine' } },
    ])('does not observe operation completion with unresolved or disabled scope: %j', async (options) => {
        const hook = await renderHook(() => useSessionCompletedBrowserActionKey('browser-signal', options));
        const before = hook.getCurrent();
        await act(async () => actionOperationStore.mergeSnapshots({ serverId: 'browser-home', snapshots: [
            ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'browser-open', revision: 2,
                actionId: 'browser.view.open', state: 'succeeded', title: 'Open Browser', createdAt: 1, startedAt: 1, settledAt: 2,
                scope: { accountId: 'browser-account', machineId: 'browser-machine', sessionId: 'browser-signal' },
                cancellation: 'unsupported' }),
        ] }));
        expect(hook.getCurrent()).toBe(before);
        await hook.unmount();
    });

    it('ignores streaming/result and sibling updates, but publishes newly completed browser actions', async () => {
        const previousState = storage.getState();
        const action: ToolCallMessage = {
            kind: 'tool-call', id: 'browser-call', localId: null, createdAt: 2, children: [],
            tool: { name: 'mcp__happier__action_execute', state: 'running',
                input: { actionId: 'browser.automation.click', input: {} },
                createdAt: 2, startedAt: 2, completedAt: null, description: null },
        };
        const text: Message = { kind: 'agent-text', id: 'streaming', localId: null, createdAt: 1, text: 'first' };
        const foreign: ToolCallMessage = { ...action, id: 'foreign-call',
            tool: { ...action.tool, name: 'mcp__foreign__action_execute', state: 'completed' } };
        const snapshot = (messages: readonly Message[], version: number): SessionMessages => {
            const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
            return { messageIdsOldestFirst: messages.map(message => message.id), messagesById, messagesMap: messagesById,
                messagesVersion: version, isLoaded: true, reducerState: createReducer(),
                latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null };
        };
        try {
            storage.setState({ sessionMessages: { 'browser-signal': snapshot([text, action, foreign], 1) } });
            let renders = 0;
            const hook = await renderHook(() => { renders++; return useSessionCompletedBrowserActionKey('browser-signal'); });
            expect(hook.getCurrent()).toBe('');
            const before = renders;
            for (let index = 0; index < 20; index++) {
                await act(async () => storage.setState({ sessionMessages: {
                    'browser-signal': snapshot([{ ...text, text: `stream ${index}` }, action, foreign], index + 2),
                    sibling: snapshot([{ ...text, text: `sibling ${index}` }], index),
                } }));
            }
            expect(renders - before).toBe(0);
            await act(async () => storage.setState({ sessionMessages: { 'browser-signal': snapshot([
                text, { ...action, tool: { ...action.tool, state: 'completed', completedAt: 3 } }, foreign,
            ], 22) } }));
            expect(hook.getCurrent()).toBe('browser-call');
            const completedRenders = renders;
            await act(async () => storage.setState({ sessionMessages: { 'browser-signal': snapshot([
                text, { ...action, tool: { ...action.tool, state: 'completed', result: { largeResult: 'changed' } } }, foreign,
            ], 23) } }));
            expect(hook.getCurrent()).toBe('browser-call');
            expect(renders).toBe(completedRenders);
            await hook.unmount();
        } finally {
            await act(async () => storage.setState(previousState));
        }
    });
});
