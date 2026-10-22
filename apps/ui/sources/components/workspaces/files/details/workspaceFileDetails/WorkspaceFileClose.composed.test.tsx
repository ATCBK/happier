import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import {
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';
import type { WorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import type { PaneDetailsState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';

installWorkspaceFileDetailsCommonModuleMocks({ modal: () => vi.importActual('@/modal') });
installWorkspaceFileDetailsActionBoundary();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Test Renderer cannot paint DOM portals or mount Radix's DOM effects. Keep the app's entire modal path real.
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());

const { ModalProvider } = await import('@/modal');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { DetailsTabStrip } = await import('@/components/appShell/panes/details/workspace/DetailsTabStrip');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { buildDetailsWorkspaceStateView } = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors');
const {
    applyCloseDetailsTab, applyOpenDetailsTab, applyPinDetailsTab, applySetActiveDetailsTab,
    applySetDetailsTabState, applyUnpinDetailsTab, createEmptyPaneDetailsState,
} = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceReducer');
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const { useWorkspaceFileEditorCommands } = await import('./useWorkspaceFileEditorCommands');

const tab = createWorkspaceFileDetailsTab('src/retry.ts');
const scope = { serverId: '', machineId: 'm1', rootPath: '/repo' };
const actionBoundary = getWorkspaceFileDetailsActionBoundary();
const refreshAll = async () => {};
let editor!: WorkspaceFileEditorState;
let details!: PaneDetailsState;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;

function EditorBody({ persistDraft }: Readonly<{ persistDraft: (draft: WorkspaceFileEditorDraft | null) => void }>) {
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    editor = useWorkspaceFileEditorState({
        scope, accountId: 'account-a', filePath: 'src/retry.ts', displayMode: 'file',
        fileText: 'saved text', fileHash: 'saved-hash', fileWriteSupported, setFileWriteSupported,
        fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: false, filesEditorChangeDebounceMs: 100, mountedRef, refreshAll, persistDraft,
    });
    useWorkspaceFileEditorCommands({ editor, tabKey: tab.key, serverId: scope.serverId,
        accountId: 'account-a', focused: true, onStart: editor.startEditingFile });
    return null;
}

function FileWorkspace() {
    const [state, setDetails] = React.useState(() => applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' }));
    details = state;
    const pane = React.useMemo(() => ({
        setActiveDetailsTab: (key: string) => setDetails(previous => applySetActiveDetailsTab(previous, key)),
        pinDetailsTab: (key: string) => setDetails(previous => applyPinDetailsTab(previous, key)),
        unpinDetailsTab: (key: string) => setDetails(previous => applyUnpinDetailsTab(previous, key)),
        closeDetailsTab: (key: string) => setDetails(previous => applyCloseDetailsTab(previous, key)),
    }), []);
    const persistDraft = React.useCallback((draft: WorkspaceFileEditorDraft | null) => {
        setDetails(previous => applySetDetailsTabState(previous, tab.key, draft));
    }, []);
    const group = buildDetailsWorkspaceStateView(state).groups[0];
    return <ModalProvider><KeyboardShortcutProvider handlers={{}}>
        {group ? <DetailsTabStrip pane={pane} group={group} testIds={{ tabClose: () => 'close-file' }} /> : null}
        {state.tabsByKey[tab.key] ? <EditorBody persistDraft={persistDraft} /> : null}
    </KeyboardShortcutProvider></ModalProvider>;
}

describe('dirty File Close through the real strip, editor guard and modal host', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://editor.test' });
        scope.serverId = await prepareWorkspaceFileDetailsActionBoundary();
        actionBoundary.read.mockReset();
    });
    afterEach(async () => {
        await standardCleanup();
        await cleanupWorkspaceFileDetailsActionBoundary();
        browser.restore();
    });

    it.each(['keepEditing', 'discard', 'save', 'failedSave'] as const)('presents the existing decision and applies %s', async decision => {
        actionBoundary.read.mockResolvedValue(decision === 'failedSave'
            ? { success: false, errorCode: 'hash_mismatch', error: 'Changed on disk' }
            : { success: true, hash: 'new-hash' });
        const screen = await renderScreen(<FileWorkspace />);
        await act(async () => { editor.startEditingFile(); });
        await act(async () => { editor.onEditorChange('unfinished draft'); });
        expect(editor.readSnapshot()).toMatchObject({ dirty: true });
        await screen.pressByTestIdAsync('close-file');
        // These are the public buttons of the actual WebAlertModal, not a fake alert callback.
        expect(screen.findByTestId('web-modal-button-0')).not.toBeNull();
        expect(screen.findByTestId('web-modal-button-1')).not.toBeNull();
        expect(screen.findByTestId('web-modal-button-2')).not.toBeNull();
        expect(details.tabsByKey[tab.key]).toBeDefined();
        const button = decision === 'discard' ? 0 : decision === 'keepEditing' ? 2 : 1;
        await screen.pressByTestIdAsync(`web-modal-button-${button}`);
        if (decision === 'discard') {
            expect(details.tabsByKey[tab.key]).toBeUndefined();
            expect(details.tabState[tab.key]).toBeUndefined();
        } else {
            expect(details.tabsByKey[tab.key]).toBeDefined();
            expect(editor.readSnapshot()).toMatchObject({ dirty: decision !== 'save' });
            expect(editor.getEditorText()).toBe('unfinished draft');
        }
        expect(actionBoundary.calls).toHaveLength(decision === 'save' || decision === 'failedSave' ? 1 : 0);
        if (decision === 'save') {
            await screen.pressByTestIdAsync('close-file');
            expect(details.tabsByKey[tab.key]).toBeUndefined();
            expect(actionBoundary.calls).toHaveLength(1);
        }
    });
});
