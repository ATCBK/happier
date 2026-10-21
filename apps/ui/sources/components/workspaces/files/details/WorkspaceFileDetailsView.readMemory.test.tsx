import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { FileFindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

installSessionFilesViewBoundaries({ platformOS: 'android' });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { FilePageHeader } = await import('../file/FilePageHeader');
const { CodeLinesViewCore } = await import('@/components/ui/code/view/CodeLinesViewCore');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { readWorkspaceFileView } = await import('./workspaceFileDetails/workspaceFileView');
const { useWorkspaceFileView } = await import('./workspaceFileDetails/useWorkspaceFileView');
const filePath = 'source.txt';
const tabKey = `file:${filePath}`;
const scopeId = 'project:read-memory';
const text = Array.from({ length: 24 }, (_, index) => `line ${index + 1} needle`).join('\n');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let pane: AppPaneScopeApi;
const scrollToIndex = vi.fn();

function FilePane(props: Readonly<{ shown: boolean; seed?: FileFindSeed; anchorLine?: number }>) {
    pane = useAppPaneScope(scopeId);
    React.useEffect(() => { pane.openDetailsTab(createWorkspaceFileDetailsTab(filePath), { intent: 'pinned' }); }, []);
    return <KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>{props.shown && pane.scopeState?.details.tabs.some(tab => tab.key === tabKey)
        ? <WorkspaceFileDetailsView scopeId={scopeId} scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null}
            findSeed={props.seed} deepLinkAnchor={props.anchorLine ? { source: 'file', anchor: { kind: 'fileLine', startLine: props.anchorLine } } : null} />
        : null}</PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>;
}

beforeEach(async () => {
    standardCleanup(); scrollToIndex.mockClear();
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_read_memory', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: () => ({ success: true, content: Buffer.from(text).toString('base64') }) });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_read_memory',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? new Response('{}', { status: 404 });
        },
        rpc: () => ({ success: true, exists: true, kind: 'file', sizeBytes: Buffer.byteLength(text) }) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it.each(['file', 'scope'] as const)('keeps a departing reader patch bound to its original tab when the retained page changes %s', async (change) => {
    let patch!: ReturnType<typeof useWorkspaceFileView>['patchView'];
    let originalPane!: AppPaneScopeApi;
    function Binding(props: Readonly<{ path: string; scopeId?: string }>) {
        pane = useAppPaneScope(props.scopeId ?? scopeId);
        const first = useAppPaneScope(scopeId);
        originalPane = first;
        patch = useWorkspaceFileView(pane, `file:${props.path}`).patchView;
        React.useEffect(() => { pane.openDetailsTab(createWorkspaceFileDetailsTab(props.path), { intent: 'pinned' }); }, [props.path, props.scopeId]);
        return null;
    }
    const screen = await fixture.render(<Binding path={filePath} />);
    try {
        const departing = patch;
        await screen.update(fixture.wrap(<Binding path={change === 'file' ? 'other.txt' : filePath} scopeId={change === 'scope' ? 'project:other' : scopeId} />));
        await act(async () => { departing({ findQuery: 'original tab' }); });
        expect(readWorkspaceFileView(originalPane.scopeState?.details.tabState[tabKey]).findQuery).toBe('original tab');
        expect(readWorkspaceFileView(pane.scopeState?.details.tabState[change === 'file' ? 'file:other.txt' : tabKey]).findQuery).toBeUndefined();
    } finally { await screen.unmount(); }
});

it('captures the real read owners into tab state and restores both after a pane remount, with explicit requests winning', async () => {
    const screen = await fixture.render(<FilePane shown />, { createNodeMock: element => Array.isArray(element.props.data) ? { scrollToIndex } : null });
    try {
        await vi.waitFor(() => expect(screen.findAllByType(CodeLinesViewCore)).toHaveLength(1));
        await act(async () => { screen.findByType(FilePageHeader).props.find.onOpen(); });
        await act(async () => { screen.changeTextByTestId('file-viewer-find.input', 'needle'); });
        await act(async () => { screen.findByType(CodeLinesViewCore).findByType('FlatList').props.onViewableItemsChanged({ viewableItems: [{ index: 7 }] }); });
        await screen.update(fixture.wrap(<FilePane shown={false} />));
        expect(readWorkspaceFileView(pane.scopeState?.details.tabState[tabKey])).toMatchObject({ scrollLine: 8, findQuery: 'needle' });

        scrollToIndex.mockClear();
        await screen.update(fixture.wrap(<FilePane shown />));
        await vi.waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 7, viewPosition: 0, animated: false })));
        expect(screen.findByTestId('file-viewer-find.input')).toBeNull();
        await act(async () => { screen.findByType(FilePageHeader).props.find.onOpen(); });
        expect(screen.findByTestId('file-viewer-find.input')?.props.value).toBe('needle');

        await screen.update(fixture.wrap(<FilePane shown={false} />));
        scrollToIndex.mockClear();
        const seed: FileFindSeed = { query: 'line 12', options: { matchCase: false, regex: false },
            target: { kind: 'file', path: filePath, anchor: { kind: 'fileLine', startLine: 12 } } };
        await screen.update(fixture.wrap(<FilePane shown seed={seed} anchorLine={18} />));
        await vi.waitFor(() => expect(screen.findByTestId('file-viewer-find.input')?.props.value).toBe('line 12'));
        await vi.waitFor(() => expect(scrollToIndex).toHaveBeenLastCalledWith(expect.objectContaining({ index: 11 })));
        expect(scrollToIndex.mock.calls.some(([target]) => target.index === 7)).toBe(false);
    } finally { await screen.unmount(); }
});
