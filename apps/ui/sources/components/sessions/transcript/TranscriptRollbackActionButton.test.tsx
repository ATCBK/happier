import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createReducer } from '@happier-dev/session-core/reducer';
import { MessageMetaSchema, type UserTextMessage } from '@happier-dev/session-core/messages';
import type { StorageState } from '@/sync/store/types';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import {
    getTranscriptModalMockRef,
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeSpy = vi.fn();
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
const writeExistingSessionDraftSpy = vi.fn();
const rollbackStorageState = vi.hoisted(() => ({ value: {} as Partial<StorageState> }));
const createDefaultActionExecutorSpy = vi.fn((_: Readonly<{
    resolveServerIdForSessionId?: (sessionId: string) => string | null;
}> | undefined) => ({
    execute: (actionId: unknown, input: unknown, ctx: unknown) => executeSpy(actionId, input, ctx),
}));
const preferredSessionServerIdState = vi.hoisted(() => {
    let value = 'server-explicit';
    const listeners = new Set<(nextValue: string) => void>();

    return {
        get value() {
            return value;
        },
        set value(nextValue: string) {
            value = nextValue;
            for (const listener of listeners) {
                listener(nextValue);
            }
        },
        subscribe(listener: (nextValue: string) => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const resolveSessionTargetServerIdSpy = vi.fn<(sessionId: string) => string | null>();

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) {
        return style && typeof style === 'object' ? style as Record<string, unknown> : {};
    }
    return Object.assign({}, ...style.map(flattenStyle));
}

installTranscriptCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSession: () => ({
                    id: 's1',
                    serverId: 'server-explicit',
                    metadata: { machineId: 'm1' },
                } as any),
                storage: createLiveStorageStoreMock(() => rollbackStorageState.value),
            },
        });
    },
});
resetTranscriptCommonModuleMockState();

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => createDefaultActionExecutorSpy(opts as any),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: 'server-explicit', accountId: 'account-test' }),
    captureActiveServerAccountScopeLifetime: () => ({
        scope: { serverId: 'server-explicit', accountId: 'account-test' },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    }),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    writeExistingSessionDraft: (input: unknown) => writeExistingSessionDraftSpy(input),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => {
        const [sessionServerId, setSessionServerId] = React.useState(preferredSessionServerIdState.value);
        React.useEffect(() => preferredSessionServerIdState.subscribe(setSessionServerId), []);
        return sessionServerId;
    },
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: (sessionId: string, fallbackServerId?: string | null) =>
        resolveSessionTargetServerIdSpy(sessionId) ?? fallbackServerId ?? null,
}));

// Cold production imports belong to collection, before the renderer/test lifetime starts.
// Import-time consumers observe the same touch-primary browser as the test renders.
const collectionBrowser = await installBrowserRuntimeForTests({ url: 'https://rollback-target.test' });
Object.defineProperty(collectionBrowser.window.navigator, 'maxTouchPoints', { configurable: true, value: 1 });
try {
    await import('./TranscriptRollbackActionButton');
} finally {
    collectionBrowser.restore();
}

describe('TranscriptRollbackActionButton', () => {
    afterEach(() => {
        standardCleanup();
        browser?.restore();
        browser = null;
    });

    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://rollback-target.test' });
        // This regression covers a touch-primary web host, not a precise desktop pointer.
        Object.defineProperty(browser.window.navigator, 'maxTouchPoints', { configurable: true, value: 1 });
        executeSpy.mockReset();
        rollbackStorageState.value = {};
        writeExistingSessionDraftSpy.mockReset();
        createDefaultActionExecutorSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockReset();
        preferredSessionServerIdState.value = 'server-explicit';
        getTranscriptModalMockRef().current?.spies.alert?.mockReset();
    });

    it('executes the latest-turn rollback action for the session', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(executeSpy).toHaveBeenCalledWith(
            'session.rollback',
            {
                sessionId: 'session-1',
                target: { type: 'latest_turn' },
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).not.toHaveBeenCalled();
        const rollbackAction = screen.findByTestId('rollback-action');
        expect(rollbackAction?.props.accessibilityLabel).toBe('session.rollback.latestTurnA11y');
        const rollbackStyle = typeof rollbackAction?.props.style === 'function'
            ? rollbackAction.props.style({ pressed: false })
            : rollbackAction?.props.style;
        // Drawn size is the caller's; the touch target is the shared hit area, never a floor on the box.
        expect(flattenStyle(rollbackStyle).minWidth).toBeUndefined();
        expect(flattenStyle(rollbackStyle).minHeight).toBeUndefined();
        expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(expect.objectContaining({
            resolveServerIdForSessionId: expect.any(Function),
        }));
        expect(createDefaultActionExecutorSpy.mock.calls[0]?.[0]?.resolveServerIdForSessionId?.('s1')).toBe('server-explicit');
        await screen.unmount();
    }, 120000);

    it('re-resolves the session server when the preferred server changes', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
            />,
        );

        expect(createDefaultActionExecutorSpy.mock.calls[0]?.[0]?.resolveServerIdForSessionId?.('s1')).toBe('server-explicit');

        await act(async () => {
            preferredSessionServerIdState.value = 'server-reactive';
            screen.tree.update(
                <TranscriptRollbackActionButton
                    sessionId="session-1"
                    testID="rollback-action"
                />,
            );
        });

        expect(createDefaultActionExecutorSpy.mock.calls.at(-1)?.[0]?.resolveServerIdForSessionId?.('s1')).toBe('server-reactive');
        await screen.unmount();
    });

    it('alerts when the underlying rollback RPC result is not ok', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: false, errorMessage: 'nope' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                restoredDraftText="do not restore"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).toHaveBeenCalledWith('common.error', 'nope');
        expect(writeExistingSessionDraftSpy).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('prefills the session draft after rollback-to-point succeeds', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });
        const token = '[Auth fix](happier-ref:session:auth)';
        const attachmentToken = '[Issue #42](happier-ref:attachment:issue-42)';
        const attachment = { v: 1, instanceId: 'issue-42', attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42', value: { issueId: 42 }, presentation: { label: 'Issue #42', typeLabel: 'Issue' } };
        const message: UserTextMessage = { kind: 'user-text', id: 'source', localId: null, createdAt: 1, seq: 7,
            text: `${token} / ${token} / ${attachmentToken} / [Literal](happier-ref:session:auth)`,
            meta: MessageMetaSchema.parse({ happierStructuredInputV1: { v: 1, mentions: [
                { kind: 'happier.session', ref: 'session:auth', token, label: 'Auth fix' },
            ], composerAttachments: [attachment] } }) };
        const messagesById = { source: message };
        rollbackStorageState.value = { sessionMessages: { 'session-1': { messagesById, messagesMap: messagesById,
            messageIdsOldestFirst: ['source'], messagesVersion: 1, reducerState: createReducer(),
            latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null, isLoaded: true } } };

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                restoredDraftText={message.text}
            />,
        );
        expect(screen.findByTestId('rollback-action')?.props.accessibilityLabel).toBe('session.rollback.beforeUserMessageA11y');
        await screen.pressByTestIdAsync('rollback-action');

        expect(executeSpy).toHaveBeenCalledWith(
            'session.rollback',
            {
                sessionId: 'session-1',
                target: { type: 'before_user_message', userMessageSeq: 7 },
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        expect(writeExistingSessionDraftSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            patch: { text: message.text, attachments: [attachment], mentions: [
                expect.objectContaining({ ref: 'session:auth', start: 0, end: token.length }),
                expect.objectContaining({ ref: 'session:auth', start: token.length + 3, end: token.length * 2 + 3 }),
                expect.objectContaining({ ref: 'attachment:issue-42', start: token.length * 2 + 6,
                    end: token.length * 2 + 6 + attachmentToken.length }),
            ] },
        }));
        await screen.unmount();
    });

    it('does not prefill the draft when rollback is only routed to an approval request', async () => {
        executeSpy.mockResolvedValueOnce({
            ok: true,
            result: {
                kind: 'approval_request_created',
                artifactId: 'artifact-1',
                actionId: 'session.rollback',
            },
        });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                restoredDraftText="edit this prompt"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(writeExistingSessionDraftSpy).not.toHaveBeenCalled();
        expect(getTranscriptModalMockRef().current?.spies.alert).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('runs advanced code-only rollback through production action after explicit confirmation', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { status: 'applied' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                checkpointCodeRollback={{
                    conversationRollbackSupported: false,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                }}
            />,
        );
        getTranscriptModalMockRef().current?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'code_only_without_stash',
            backupMode: 'happier_checkpoint_only',
            codeOnlyTranscriptDivergenceConfirmed: true,
        }));

        await screen.pressByTestIdAsync('rollback-action');

        expect(getTranscriptModalMockRef().current?.spies.show).toHaveBeenCalled();
        expect(executeSpy).toHaveBeenCalledWith(
            'session.checkpoint_code_rollback',
            {
                v: 1,
                sessionId: 'session-1',
                turnId: 'turn-1',
                cwd: '/repo',
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        await screen.unmount();
    });

    it('composes conversation rollback in UI before invoking code-only rollback action', async () => {
        executeSpy
            .mockResolvedValueOnce({ ok: true, result: { ok: true } })
            .mockResolvedValueOnce({ ok: true, result: { status: 'applied' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                checkpointCodeRollback={{
                    conversationRollbackSupported: true,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                }}
            />,
        );
        getTranscriptModalMockRef().current?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
        }));

        await screen.pressByTestIdAsync('rollback-action');

        expect(executeSpy).toHaveBeenNthCalledWith(
            1,
            'session.rollback',
            {
                sessionId: 'session-1',
                target: { type: 'before_user_message', userMessageSeq: 7 },
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        expect(executeSpy).toHaveBeenNthCalledWith(
            2,
            'session.checkpoint_code_rollback',
            {
                v: 1,
                sessionId: 'session-1',
                turnId: 'turn-1',
                cwd: '/repo',
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        await screen.unmount();
    });

    it('surfaces checkpoint code rollback conflict after conversation rollback succeeds', async () => {
        executeSpy
            .mockResolvedValueOnce({ ok: true, result: { ok: true } })
            .mockResolvedValueOnce({
                ok: true,
                result: {
                    status: 'conflict',
                    diagnostics: ['reverse patch did not apply cleanly'],
                },
            });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                checkpointCodeRollback={{
                    conversationRollbackSupported: true,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                }}
            />,
        );
        getTranscriptModalMockRef().current?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
        }));

        await screen.pressByTestIdAsync('rollback-action');

        expect(getTranscriptModalMockRef().current?.spies.alert).toHaveBeenCalledWith(
            'common.error',
            expect.stringContaining('reverse patch did not apply cleanly'),
        );
        await screen.unmount();
    });

});
