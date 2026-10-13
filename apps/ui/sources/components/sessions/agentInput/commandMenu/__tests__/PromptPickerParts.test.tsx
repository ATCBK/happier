import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { UserMessageHistoryEntriesSnapshot } from '@/hooks/session/useUserMessageHistoryEntries';
import { buildPromptPickerRows, type PromptPickerRow } from '../promptPickerRows';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
const { PromptPickerFooter, PromptPickerPreview, PromptPickerRowContent } = await import('../PromptPickerParts');
afterEach(standardCleanup);

const history: UserMessageHistoryEntriesSnapshot = {
    entries: [], coverage: 'partial', hasMore: false, isLoading: false, error: false,
    progress: { pagesLoaded: 1, sessionsSearched: 1, totalSessions: 1 },
    loadMore: async () => {}, retry: async () => {}, stop: () => {},
};

describe('picker coverage and preview read admission', () => {
    it.each([false, true])('retains partial history coverage after known paging ends (hardware=%s)', async (hardwareKeyboard) => {
        const screen = await renderScreen(<PromptPickerFooter history={history} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.findAllByType(KeyHint).map((hint) => hint.props.label)).toEqual(hardwareKeyboard
            ? ['↑↓', '↵', 'Ctrl+Enter', 'Ctrl+D'] : []);
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.partialHistory');
        await screen.update(<PromptPickerFooter history={{ ...history, coverage: 'loaded', hasMore: true }} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.loadedHistory');
        expect(screen.findByTestId('prompt-picker-history-more')).not.toBeNull();
        await screen.update(<PromptPickerFooter history={{ ...history, isLoading: true }} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        await screen.pressByTestIdAsync('prompt-picker-history-stop');
        await screen.update(<PromptPickerFooter history={{ ...history, error: true }} hardwareKeyboard={hardwareKeyboard} canSend applyError={false} />);
        expect(screen.findByTestId('prompt-picker-history-coverage')).not.toBeNull();
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.historyError');
    });

    it('keeps key hints for the wide picker and leaves them out of the narrow one', async () => {
        const hints = async (wide: boolean) => (await renderScreen(<PromptPickerFooter history={history} hardwareKeyboard wide={wide}
            canSend applyError={false} />)).findAllByType(KeyHint).length;
        expect(await hints(true)).toBe(4);
        expect(await hints(false)).toBe(0);
    });

    it('says the library is still arriving while other rows already show', async () => {
        const screen = await renderScreen(<PromptPickerFooter history={{ ...history, coverage: 'complete' }} hardwareKeyboard={false} canSend applyError={false} libraryLoading />);
        expect(screen.getTextContent()).toContain('agentInput.promptPicker.loadingLibrary');
        await screen.update(<PromptPickerFooter history={{ ...history, coverage: 'complete' }} hardwareKeyboard={false} canSend applyError={false} libraryLoading={false} />);
        expect(screen.getTextContent()).not.toContain('agentInput.promptPicker.loadingLibrary');
    });

    it('names a Sent before row\'s session only when it adds something, and always keeps the time', async () => {
        const text = 'The settings modal flickers when the window resizes. Find out why and fix it.';
        const entry = { serverId: 'home', sessionId: 's', messageId: 'm', seq: 2, createdAtMs: 0, text };
        const [row] = buildPromptPickerRows({ documents: [], invocations: [], builtIns: [], history: [entry], sessionId: null, query: '' });
        const render = (name: string) => renderScreen(<PromptPickerRowContent row={row} query="" nowMs={12 * 60_000}
            folderNames={new Map()} sessionNames={new Map([['s', name]])} onToggleFavorite={() => {}} />);
        // A session named after its first message would say the same thing twice.
        const same = (await render('The settings modal flickers when the window resizes. Find out why and…')).getTextContent();
        expect(same).not.toContain('Find out why and…');
        expect(same).toContain('time.minutesAgoShort');
        const other = (await render('Fix settings modal remount')).getTextContent();
        expect(other).toContain('Fix settings modal remount');
        expect(other).toContain('time.minutesAgoShort');
    });

    it('previews a skill-style prompt from its body, not its front matter header', async () => {
        const builtIns = [{ token: '/diagnose', title: 'Diagnose', allowArgs: true,
            body: '---\nname: diagnose\nmetadata: {"homepage":"x"}\n---\n\n# Diagnose\n\nFind the cause of $ARGUMENTS.' }];
        const [row] = buildPromptPickerRows({ documents: [], invocations: [], builtIns, history: [], sessionId: null, query: '' });
        const screen = await renderScreen(<PromptPickerPreview row={row} read={async (r) => r.kind === 'builtIn' ? r.prompt.body : ''} nowMs={0} folderNames={new Map()} sessionNames={new Map()} />);
        await act(async () => {});
        const text = screen.getTextContent();
        expect(text).toContain('Diagnose');
        expect(text).toContain('$ARGUMENTS');
        expect(text).not.toContain('metadata:');
    });

    it('reads a preview once across filtering, then refreshes on selection or content revision', async () => {
        const documents = [
            { artifactId: 'one', title: 'Run tests', tags: [], folderId: null, favorite: false, updatedAtMs: 1 },
            { artifactId: 'two', title: 'Other tests', tags: [], folderId: null, favorite: false, updatedAtMs: 1 },
        ];
        const rows = (query: string) => buildPromptPickerRows({ documents, invocations: [], builtIns: [], history: [], sessionId: null, query });
        let bodyRevision = 0;
        const read = async (row: PromptPickerRow) => `${row.id} body revision ${++bodyRevision}`;
        const preview = (query: string, index = 0) => <PromptPickerPreview row={rows(query)[index]} read={read} nowMs={0} folderNames={new Map()} sessionNames={new Map()} />;
        const screen = await renderScreen(preview(''));
        await act(async () => {});
        expect(screen.getTextContent()).toContain('doc:one body revision 1');
        await screen.update(preview('Run'));
        expect(screen.getTextContent()).toContain('doc:one body revision 1');
        await screen.update(preview('', 1));
        expect(screen.getTextContent()).toContain('doc:two body revision 2');
        documents[1] = { ...documents[1], updatedAtMs: 2 };
        await screen.update(preview('', 1));
        expect(screen.getTextContent()).toContain('doc:two body revision 3');
    });
});
