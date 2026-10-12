import * as React from 'react';
import { act } from 'react-test-renderer';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage } from '@happier-dev/session-core/messages';
import { createTestSessionTranscriptSource, makeToolCall, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TranscriptFindProvider } from './find/TranscriptFindContext';
import { createTranscriptFindModel } from './find/useTranscriptFind';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { MessageView } from './MessageView';
import { ToolCallsGroupUnitToolRowWithSessionCommon } from './toolCalls/units/ToolCallsGroupUnitToolRow';
import { ToolCallsGroupViewWithSessionCommon } from './turns/toolCalls/ToolCallsGroupView';
import { createTranscriptSessionCommonPropsFixture } from './toolCalls/units/toolCallsGroupUnitsTestFixtures';

installMessageViewCommonModuleMocks();
installDisconnectedServerSocketBoundary();
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
await loadSyncSingletonForTests();

let environment: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
beforeEach(async () => { environment = await restoreServerAccountForTest({ serverUrl: 'http://find-tools.test' }); });
afterEach(async () => { standardCleanup(); await environment.dispose(); });

describe('MessageView tool Find identity', () => {
    it.each([
        ['cards', 'message'], ['activity_feed', 'message'],
        ['cards', 'unit'], ['activity_feed', 'unit'], ['activity_feed', 'group'], ['cards', 'group'],
    ] as const)('draws counted Read and Diff body matches through %s %s rows using the original message identity', async (chrome, rowKind) => {
        getStorage().setState(state => ({ settings: { ...state.settings, toolViewTimelineChromeMode: chrome } }));
        // Claude's numbered plain-string Read result and an Edit diff are distinct from the
        // predecessor's one-line file.content Read and synthetic Diff input.files payloads.
        const readBody = Array.from({ length: 32 }, (_, index) => `${index + 1}\t${index === 14
            ? '// must not remount the modal' : `const line${index + 1} = ${index + 1};`}`).join('\n');
        const oldText = Array.from({ length: 32 }, (_, index) => `const line${index + 1} = ${index + 1};`).join('\n');
        const newText = oldText + '\n// must not remount the modal';
        const messages: ToolCallMessage[] = [
            { kind: 'tool-call', id: 'internal-read', realID: 'persisted-read', localId: null, seq: 1, createdAt: 1,
                tool: makeToolCall({ id: 'read-call', name: 'Read', state: 'completed', input: { file_path: '/tmp/a.ts' },
                    result: readBody }), children: [] },
            { kind: 'tool-call', id: 'internal-diff', realID: 'persisted-diff', localId: null, seq: 2, createdAt: 2,
                tool: makeToolCall({ id: 'diff-call', name: 'Edit', state: 'completed', input: { file_path: '/tmp/a.ts',
                    old_string: oldText, new_string: newText }, result: {} }), children: [] },
        ];
        const model = createTranscriptFindModel({
            readCorpus: () => ({ messages, history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }),
            loadPage: null, jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {},
        });
        model.setQuery('must not remount the modal');
        await model.settled();
        expect(model.status).toMatchObject({ current: 1, total: 2 });
        const source = createTestSessionTranscriptSource({ messages });
        const common = createTranscriptSessionCommonPropsFixture({ toolChromeCommon: { toolViewTimelineChromeMode: chrome } });
        const interaction = { canSendMessages: true, canApprovePermissions: true } as const;
        const screen = await renderWithSessionTranscriptSource(<TranscriptFindProvider store={model.rowStore}>
            {messages.map(message => <View key={message.id} testID={`find-tool:${message.id}`}>
                {rowKind === 'message' ? <MessageView message={message} metadata={null} sessionId="s1" />
                    : rowKind === 'unit' ? <ToolCallsGroupUnitToolRowWithSessionCommon {...common}
                        message={message} metadata={null} sessionId="s1" groupId="tools" expanded interaction={interaction} />
                    : <ToolCallsGroupViewWithSessionCommon {...common} id="tools" status="completed"
                        toolMessages={[message]} metadata={null} sessionId="s1" expanded setExpanded={() => {}}
                        interaction={interaction} />}
            </View>)}
        </TranscriptFindProvider>, source);
        const currentText = (messageId: string) => screen.findHostByTestId(`find-tool:${messageId}`)!
            .findAll(node => typeof node.type === 'string' && node.props.testID === 'find-match-current')
            .map(node => node.children.join('')).join('');
        expect(currentText('internal-read')).toBe('must not remount the modal');
        expect(currentText('internal-diff')).toBe('');
        await act(async () => { model.step(1); await model.settled(); });
        expect(currentText('internal-read')).toBe('');
        expect(currentText('internal-diff')).toBe('must not remount the modal');
        await act(() => model.close());
        expect(currentText('internal-read')).toBe('');
        expect(currentText('internal-diff')).toBe('');
        await screen.unmount();
        model.dispose();
    });
});
