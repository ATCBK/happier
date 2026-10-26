import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { createTestSessionTranscriptSource, createToolCallMessageFixture, renderScreen, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        });
    },
});
const sessionId = 'session-1';
const runtime = installSessionPaneRuntimeTestHarness({ sessionId });
const { storage } = await import('@/sync/domains/state/storageStore');
const { PermissionPromptCard } = await import('@/components/tools/shell/permissions/PermissionPromptCard');
beforeEach(() => {
    storage.setState({ settings: { ...storage.getState().settings,
        agentInputEnterToSend: true, agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels',
        agentInputHistoryScope: 'perSession', sessionPermissionModeApplyTiming: 'immediate',
        permissionPromptSurface: 'composer' } });
});
async function renderWithSessionTranscriptSource(
    element: React.ReactElement,
    source: ReturnType<typeof createTestSessionTranscriptSource>,
) {
    return renderScreen(wrapWithSessionTranscriptSource(element, source), { wrapper: runtime.Wrapper });
}
const toolMessageId = 't1';
const permissionId = 'perm-1';
const toolMessage = createToolCallMessageFixture({
    id: toolMessageId,
    tool: { id: `call:${toolMessageId}`, name: 'write_file', state: 'running', input: {},
        createdAt: 1, startedAt: 1, completedAt: null, description: null },
});
const permissionRequests = [{ id: permissionId, kind: 'permission' as const, createdAt: 1, tool: 'write_file', arguments: {} }];

describe('AgentInput (permission tool location)', () => {
    it('does not subscribe to transcript data when no composer permission cards are visible', async () => {
        const { AgentInput } = await import('./AgentInput');
        const source = createTestSessionTranscriptSource({ sessionId, messages: [toolMessage] });
        const idsRead = vi.spyOn(source, 'useMessageIdsOldestFirst');
        const messagesRead = vi.spyOn(source, 'useMessagesById');
        const reducerRead = vi.spyOn(source, 'useReducerState');

        const screen = await renderWithSessionTranscriptSource(<AgentInput
            value="" placeholder="x" onChangeText={() => {}} onSend={() => {}}
            sessionId={sessionId} metadata={null} autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
        />, source);

        expect(idsRead).not.toHaveBeenCalled();
        expect(messagesRead).not.toHaveBeenCalled();
        expect(reducerRead).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('updates the PermissionPromptCard location when the transcript source publishes the tool permission id', async () => {
        const { AgentInput } = await import('./AgentInput');
        const source = createTestSessionTranscriptSource({ sessionId, messages: [toolMessage] });
        const screen = await renderWithSessionTranscriptSource(<AgentInput
            value="" placeholder="x" onChangeText={() => {}} onSend={() => {}}
            sessionId={sessionId} metadata={null} autocompleteKinds={[]}
            autocompleteSuggestions={async () => []} permissionRequests={permissionRequests}
        />, source);

        expect(screen.findAllByType(PermissionPromptCard)[0]?.props.location).toBeNull();

        await act(async () => {
            source.update({ reducerState: null, metadata: null, agentState: null, messages: [{
                ...toolMessage,
                tool: { ...toolMessage.tool, permission: { id: permissionId, status: 'pending' } },
            }] });
        });

        expect(screen.findAllByType(PermissionPromptCard)[0]?.props.location).toEqual({
            kind: 'top', messageId: 'tool:call:t1', seq: null,
        });
        await screen.unmount();
    });

    it('falls back to a stable server message route when the tool call has no provider tool id', async () => {
        const { AgentInput } = await import('./AgentInput');
        const reducerState = createReducer();
        reducerState.messageIds.set('server-msg-1', toolMessageId);
        const source = createTestSessionTranscriptSource({
            sessionId, reducerState,
            messages: [{
                ...toolMessage,
                tool: { ...toolMessage.tool, id: undefined, permission: { id: permissionId, status: 'pending' } },
            }],
        });
        const screen = await renderWithSessionTranscriptSource(<AgentInput
            value="" placeholder="x" onChangeText={() => {}} onSend={() => {}}
            sessionId={sessionId} metadata={null} autocompleteKinds={[]}
            autocompleteSuggestions={async () => []} permissionRequests={permissionRequests}
        />, source);

        expect(screen.findAllByType(PermissionPromptCard)[0]?.props.location).toEqual({
            kind: 'top', messageId: 'server:server-msg-1', seq: null,
        });
        await screen.unmount();
    });
});
