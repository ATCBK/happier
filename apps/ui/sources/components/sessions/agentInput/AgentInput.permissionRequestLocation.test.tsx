import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { createTestSessionTranscriptSource, createToolCallMessageFixture, renderWithSessionTranscriptSource } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastPermissionPromptCardProps: any = null;
const toolMessageId = 't1';
const sessionId = 'session-1';
const permissionId = 'perm-1';
const toolMessage = createToolCallMessageFixture({
    id: toolMessageId,
    tool: { id: `call:${toolMessageId}`, name: 'write_file', state: 'running', input: {},
        createdAt: 1, startedAt: 1, completedAt: null, description: null },
});

const permissionRequests = [{ id: permissionId, kind: 'permission' as const, createdAt: 1, tool: 'write_file', arguments: {} }];

vi.mock('expo-image', () => ({
    Image: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 920 },
    useLayoutMaxWidth: () => 920,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 920 }),
}));

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    input: { background: '#fff' },
                    accent: { indigo: '#5856D6' },
                    box: {
                        error: { background: '#ffecec', border: '#ffa39e', text: '#a8071a' },
                        warning: { background: '#fff7e6', border: '#ffd591', text: '#ad6800' },
                    },
                    button: {
                        primary: { background: '#000', tint: '#fff' },
                        secondary: { tint: '#000', surface: '#fff' },
                    },
                    radio: { active: '#000', inactive: '#ddd' },
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    success: '#0a0',
                    warning: '#f90',
                    warningCritical: '#f00',
                    textDestructive: '#a00',
                    surfacePressed: '#eee',
                    surfacePressedOverlay: '#eee',
                    surface: '#fff',
                    shadow: { color: '#000' },
                    overlay: {
                        scrim: 'rgba(0, 0, 0, 0.45)',
                        scrimStrong: 'rgba(0, 0, 0, 0.6)',
                        text: '#FFFFFF',
                        textSecondary: 'rgba(255, 255, 255, 0.9)',
                    },
                    permission: {
                        acceptEdits: '#0a0',
                        bypass: '#0a0',
                        plan: '#0a0',
                        readOnly: '#0a0',
                        safeYolo: '#0a0',
                        yolo: '#0a0',
                    },
                    surfaceHighest: '#fafafa',
                    groupped: { background: '#fff' },
                    header: { background: '#fff', tint: '#000' },
                    textLink: '#00f',
                    agentEventText: '#666',
                },
            },
        });
    },
    icons: async () => ({
        Ionicons: () => null,
        Octicons: () => null,
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: () => {},
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'agentInputHistoryScope') return 'perSession';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                if (key === 'permissionPromptSurface') return 'composer';
                return null;
            },
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                agentInputHistoryScope: 'perSession',
                sessionPermissionModeApplyTiming: 'immediate',
                permissionPromptSurface: 'composer',
            }),
        });
    },
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({
        localSettings: {
            uiBackdropBlurEnabled: false,
        },
        localSettingsDefaults: {},
        sessionMessages: {},
    }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => {
        lastPermissionPromptCardProps = props;
        return React.createElement('PermissionPromptCard', props);
    },
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        getPrevious: () => null,
        getNext: () => null,
        push: () => {},
        reset: () => {},
    }),
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], null, () => {}, () => {}],
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement('FloatingOverlay', null, children),
}));

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
        lastPermissionPromptCardProps = null;
        const source = createTestSessionTranscriptSource({ sessionId, messages: [toolMessage] });
        const screen = await renderWithSessionTranscriptSource(<AgentInput
            value="" placeholder="x" onChangeText={() => {}} onSend={() => {}}
            sessionId={sessionId} metadata={null} autocompleteKinds={[]}
            autocompleteSuggestions={async () => []} permissionRequests={permissionRequests}
        />, source);

        expect(lastPermissionPromptCardProps?.location).toBeNull();

        await act(async () => {
            source.update({ reducerState: null, metadata: null, agentState: null, messages: [{
                ...toolMessage,
                tool: { ...toolMessage.tool, permission: { id: permissionId, status: 'pending' } },
            }] });
        });

        expect(lastPermissionPromptCardProps?.location).toEqual({
            kind: 'top', messageId: 'tool:call:t1', seq: null,
        });
        await screen.unmount();
    });

    it('falls back to a stable server message route when the tool call has no provider tool id', async () => {
        const { AgentInput } = await import('./AgentInput');
        lastPermissionPromptCardProps = null;
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

        expect(lastPermissionPromptCardProps?.location).toEqual({
            kind: 'top', messageId: 'server:server-msg-1', seq: null,
        });
        await screen.unmount();
    });
});
