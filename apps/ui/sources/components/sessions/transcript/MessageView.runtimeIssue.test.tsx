import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReducer, reducer } from '@happier-dev/session-core/reducer';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import type { Message } from '@happier-dev/session-core/messages';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderWithSessionTranscriptSource as renderScreen } from '@/dev/testkit/sessionTranscriptSource';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: vi.fn() } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: { useSetting: createUseSettingMock({ fallback: () => null }), useSession: () => null },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));
vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));
vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));
vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('@/sync/sync', () => ({ sync: { submitMessage: vi.fn(), sendMessage: vi.fn() } }));

await import('./MessageView');

const FAILURE_TEXT = 'custom-acp turn failed: Internal error: Cannot connect to API: Unable to connect. Is the computer able to access the url?';

/** The persisted shapes the host failure projector commits (runtimeFailureTranscript.ts), read back through the real reducer. */
function projectPersistedRows(rows: readonly Readonly<{ id: string; data: Record<string, unknown>; meta?: Record<string, unknown> }>[]): Message[] {
    const state = createReducer();
    const normalized = rows.map((row, index) => normalizeRawMessage(row.id, row.id, 1_000 + index, {
        role: 'agent',
        content: { type: 'acp', agentId: 'custom-acp', data: row.data },
        ...(row.meta ? { meta: row.meta } : {}),
    }, { seq: index + 1 }));
    return reducer(state, normalized.filter((m): m is NonNullable<typeof m> => m !== null)).messages;
}

const runtimeMeta = { source: 'runtime', runtimeIssueCode: 'acp_turn_failed', runtimeIssueSource: 'agent_session_error' };

describe('MessageView runtime failure rows', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders a persisted turn failure as an error event row, not as assistant prose', async () => {
        const { MessageView } = await import('./MessageView');
        const messages = projectPersistedRows([
            { id: 'reply', data: { type: 'message', message: 'Hello! How can I help?' } },
            { id: 'failure', data: { type: 'message', message: FAILURE_TEXT }, meta: runtimeMeta },
        ]);
        const failure = messages.find((message) => message.kind === 'agent-text' && message.text === FAILURE_TEXT);
        expect(failure).toBeTruthy();

        const screen = await renderScreen(<MessageView message={failure!} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
        expect(screen.findAllByType('MarkdownView' as any)).toHaveLength(0);
        expect(screen.getTextContent()).toContain(FAILURE_TEXT);
        expect(screen.findAllByType('Icon' as any).some((icon: any) => icon.props.name === 'warning')).toBe(true);
    });

    it('renders an input rejection the same way', async () => {
        const { MessageView } = await import('./MessageView');
        const rejection = 'custom-acp input rejected: Internal error: Cannot connect to API';
        const messages = projectPersistedRows([
            { id: 'rejection', data: { type: 'message', message: rejection }, meta: { ...runtimeMeta, runtimeIssueCode: 'acp_input_rejected' } },
        ]);
        const screen = await renderScreen(<MessageView message={messages[0]!} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-event-runtime-issue')).not.toBeNull();
    });

    it('keeps ordinary assistant prose, even when it mentions a failure, as a reply', async () => {
        const { MessageView } = await import('./MessageView');
        const messages = projectPersistedRows([
            { id: 'prose', data: { type: 'message', message: FAILURE_TEXT } },
        ]);
        const screen = await renderScreen(<MessageView message={messages[0]!} metadata={null} sessionId="s1" />);
        expect(screen.findByTestId('transcript-event-runtime-issue')).toBeNull();
    });
});
