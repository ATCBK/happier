// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolCallMessageFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { createSessionFileNativeTransferBoundary } from '@/components/sessions/files/sessionFileNativeTransferTestkit';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { ScmWorkingEntrySchema } from '@happier-dev/protocol/scm/workingSnapshot';
import { ScmComparisonSchema, type ScmComparison } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));
vi.mock('expo-clipboard', () => clipboard);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    // The host renderer has no measured RN list viewport; real File code rows still render.
    return createReactNativeWebMock({ ...createCapturingFlatListMock({ renderItems: true }).module,
        useWindowDimensions: () => viewport, Dimensions: { get: () => viewport } });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const filePath = 'src/retry.ts';
const svg = 'export const attempts = 3;\nexport function retryLabel(): string { return `Retry ${attempts}`; }\n';
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let transfer: ReturnType<typeof createSessionFileNativeTransferBoundary>;
let actionRequests: string[];
let readInputs: unknown[];
let scmDiff = '';
let capturedComparison: ScmComparison | null = null;
let portalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
// Compile and load the real runtime graph during collection, as the other composed File tests do.
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { ModalProvider } = await import('@/modal');
const { SelectionToolbar } = await import('@/components/ui/code/selection/SelectionToolbar');
const { ReviewCommentInlineComposer } = await import('@/components/ui/code/reviewComments/ReviewCommentInlineComposer');
const { HunkContextMenu } = await import('@/components/ui/code/diff/hunks/HunkContextMenu');
const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
beforeEach(async () => {
    standardCleanup();
    viewport.width = 1440;
    clipboard.setStringAsync.mockClear();
    // jsdom supplies the web modal DOM; Node supplies real, fetchable Blob URLs.
    vi.stubGlobal('Blob', getVitestNodeBuiltin<typeof import('node:buffer')>('node:buffer').Blob);
    vi.stubGlobal('URL', getVitestNodeBuiltin<typeof import('node:url')>('node:url').URL);
    portalBoundary = installReactDomPortalBoundaryForTests();
    actionRequests = [];
    readInputs = [];
    scmDiff = '';
    capturedComparison = null;
    transfer = createSessionFileNativeTransferBoundary({ bytes: new TextEncoder().encode(svg), name: filePath });
    const read = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://session-file-views.test',
        serverIdentityId: 'srv_edit_swap', accountId: 'alice', machineId: 'm1', tokenEpoch: 0,
        actionId: 'daemon.filesystem.readFile', execute: input => {
            readInputs.push(input);
            return transfer.rpc({ targetId: 'm1',
                method: getActionSpec('daemon.filesystem.readFile').bindings!.rpcMethod!, payload: input });
        } });
    fixture = await createSessionFilesViewFixture({ serverIdentityId: 'srv_edit_swap', machineCarrierOrigin: transfer.origin,
        // Private requester admission needs current Account provenance, not the legacy Home token default.
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.pathname.startsWith('/v1/actions/')) actionRequests.push(parsed.pathname);
            if (parsed.pathname === '/v1/machines/m1') return Response.json({ machine: read.machine });
            return await read.handle(parsed, init) ?? transfer.request(url, init);
        },
        rpc: request => request.method === 'scm.diff.file' ? { success: true, diff: scmDiff }
            : request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE && capturedComparison ? { success: true, comparison: capturedComparison,
                metadata: { sourceKey: capturedComparison.id, source: capturedComparison.source } }
            : transfer.rpc(request) });
    fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot());
    // This page edits: the editor feature is on (the shared fixture leaves it off for read-only pages).
    fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': false,
        'files.diffSyntaxHighlighting': false, 'files.editor': true } });
});
afterEach(async () => { standardCleanup(); await fixture?.dispose(); portalBoundary?.restore(); vi.unstubAllGlobals(); });

describe('File page View → Edit swap', () => {
    it('replaces settled attribution with the live writing note even with Track off, then restores it on settlement', async () => {
        const { createReducer } = await import('@happier-dev/session-core/reducer');
        const message = createToolCallMessageFixture({ id: 'writing-header', tool: { id: 'writing-header', name: 'Patch',
            input: { changes: [{ path: `${fixture.scope.rootPath}/${filePath}`, kind: { type: 'update' },
                diff: '@@ -1 +1 @@\n-export const attempts = 3;\n+export const attempts = 4;' }] },
            state: 'running', createdAt: 1, startedAt: 2, completedAt: null, description: null } });
        fixture.storage.setState({ localSettings: { ...fixture.storage.getState().localSettings, filesTrackAgentEdits: false } });
        fixture.storage.getState().applySessions([{ ...fixture.session, active: true, activeAt: Date.now(),
            thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress' }]);
        fixture.storage.setState({ sessionMessages: { [fixture.session.id]: { messageIdsOldestFirst: [message.id],
            messagesById: { [message.id]: message }, messagesMap: { [message.id]: message }, reducerState: createReducer(),
            messagesVersion: 1, isLoaded: true, latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } } });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="session:writing-header" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={fixture.session.id} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await vi.waitFor(() => expect(screen.findHostByTestId('file-page-writing')).not.toBeNull());
            expect(screen.findHostByTestId('file-page-attribution')).toBeNull();
            await act(async () => { fixture.storage.getState().applySessions([{ ...fixture.session, active: false,
                thinking: false, latestTurnStatus: 'completed' }]); });
            await vi.waitFor(() => expect(screen.findHostByTestId('file-page-writing')).toBeNull());
        } finally { await screen.unmount(); }
    });

    it.each(['workingTree', 'session'] as const)('opens and saves a removed-side Changes selection comment from %s', async source => {
        const selectedDiff = '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1,2 +1,2 @@\n-old first\n-old second\n+new first\n+new second\n';
        scmDiff = source === 'workingTree' ? selectedDiff : '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-other live text\n+unrelated live change\n';
        if (source === 'session') capturedComparison = ScmComparisonSchema.parse({ id: 'selection-comment-capture',
            source: { kind: 'session', sessionId: fixture.session.id }, repository: { rootPath: fixture.scope.rootPath }, endpoints: {},
            inventory: { state: 'complete', reasons: [], files: [{ path: filePath, changeKind: 'modified', binary: false, generated: false,
                lockfile: false, evidence: { state: 'available', unifiedDiff: selectedDiff }, occurrences: [{ id: 'capture:retry', alias: 'retry',
                    path: filePath, position: 0, before: { startLine: 1, lineCount: 2 }, after: { startLine: 1, lineCount: 2 } }] }] } });
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasPendingDelta: true }),
        ] }));
        fixture.storage.getState().applySettingsLocal({ filesDiffRendererMode: 'happier', experiments: true,
            featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': true, 'files.diffSyntaxHighlighting': false, 'files.editor': false } });
        // The native renderer's DOM selection/geometry are the boundary; all page, comment and draft owners stay real.
        const root = document.createElement('div');
        const line = document.createElement('div');
        line.setAttribute('data-code-line-kind', 'remove');
        line.setAttribute('data-code-line-old', '1');
        line.append(document.createTextNode('old first'));
        root.append(line);
        document.body.append(root);
        const range = document.createRange();
        range.selectNodeContents(line);
        range.getBoundingClientRect = () => new DOMRect(20, 30, 60, 20);
        range.getClientRects = () => [new DOMRect(20, 30, 60, 20)] as unknown as DOMRectList;
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:selection-comment" scope={fixture.scope} filePath={filePath}
                initialView={{ view: 'changes' }} sessionIdForAugmentation={source === 'session' ? fixture.session.id : null} />
        </ModalProvider>, { createNodeMock: node => node.type === 'View' ? root : null });
        try {
            await vi.waitFor(() => expect(screen.findAllByType(SelectionToolbar), screen.getTextContent()).toHaveLength(1));
            await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
            const toolbar = screen.findByType(SelectionToolbar);
            expect(toolbar.props.onComment).toEqual(expect.any(Function));
            await act(async () => { toolbar.props.onComment(); });
            await vi.waitFor(() => expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(1));
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onChange('Explain the removal'); });
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onSave(); });
            const drafts = fixture.storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(fixture.scope)];
            expect(drafts).toEqual([expect.objectContaining({ source: 'diff', filePath, body: 'Explain the removal',
                anchor: expect.objectContaining({ side: 'before', oldLine: 1 }), snapshot: expect.objectContaining({ selectedLines: ['old first'] }) })]);
        } finally { await screen.unmount(); root.remove(); window.getSelection()?.removeAllRanges(); }
    });

    it('opens the same inline comment composer from an ordinary Changes hunk menu', async () => {
        viewport.width = 390;
        scmDiff = '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old first\n+new first\n';
        fixture.storage.getState().updateWorkspaceScmSnapshot(fixture.scope, fileViewSnapshot({ entries: [
            ScmWorkingEntrySchema.parse({ path: filePath, kind: 'modified', includeStatus: ' ', pendingStatus: 'M', hasPendingDelta: true }),
        ] }));
        fixture.storage.getState().applySettingsLocal({ filesDiffRendererMode: 'happier', experiments: true,
            featureToggles: { 'scm.writeOperations': true, 'files.reviewComments': true, 'files.diffSyntaxHighlighting': false, 'files.editor': false } });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:hunk-comment" scope={fixture.scope} filePath={filePath}
                initialView={{ view: 'changes' }} sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.findAllByType(HunkContextMenu)).toHaveLength(1));
            expect(screen.findByType(DiffViewer).props.virtualized).toBe(true);
            const menu = screen.findByType(HunkContextMenu);
            expect(menu.props.review.actions.comment).toEqual(expect.any(Function));
            await act(async () => { menu.props.review.actions.comment(menu.props.hunk); });
            expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(1);
        } finally { await screen.unmount(); }
    });

    it('opens the inline comment composer at an editor selection and anchors a dirty buffer to the saved bytes', async () => {
        fixture.storage.getState().applySettingsLocal({ experiments: true, featureToggles: { 'scm.writeOperations': true,
            'files.reviewComments': true, 'files.diffSyntaxHighlighting': false, 'files.editor': true } });
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:editor-comment" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            // The editor engine is the platform boundary: a dirty buffer with a line typed above the selection.
            const live = `// typed above\n${svg}`;
            const selection = { startLine: 2, endLine: 2, text: 'export const attempts = 3;', rect: { x: 40, y: 60, width: 120, height: 18 } };
            const panel = screen.findByType(FileEditorPanel);
            (panel.props.editorRef as { current: unknown }).current = { getValue: () => live, flushPendingChange: async () => {},
                getSelection: () => selection, subscribeSelection: () => () => {} };
            await act(async () => { panel.props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            await vi.waitFor(() => expect(screen.findAllByType(SelectionToolbar)).toHaveLength(1));
            const toolbar = screen.findByType(SelectionToolbar);
            expect(toolbar.props.onComment).toEqual(expect.any(Function));
            await act(async () => { toolbar.props.onComment(); });
            // The page's one inline composer opens in the editor, which stays mounted with its buffer.
            await vi.waitFor(() => expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(1));
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1);
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onChange('Why three?'); });
            await act(async () => { screen.findByType(ReviewCommentInlineComposer).props.onSave(); });
            const drafts = fixture.storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(fixture.scope)];
            expect(drafts).toEqual([expect.objectContaining({ source: 'file', filePath, body: 'Why three?',
                anchor: expect.objectContaining({ startLine: 1, endLine: 1 }),
                snapshot: expect.objectContaining({ selectedLines: ['export const attempts = 3;'] }) })]);
            expect(screen.findAllByType(ReviewCommentInlineComposer)).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    it('gives the bottom seat to the working capsule after a phone Ask is sent, and takes it back when the turn ends', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { PhoneAskSheetProvider } = await import('@/components/sessions/composer/phoneAsk/phoneAskSheetState');
        const sheet = (phase: 'closed' | 'open' | 'working') => ({ phase, open: () => {}, close: () => {}, sent: () => {}, finish: () => {} });
        const page = (phase: 'closed' | 'open' | 'working') => <ModalProvider><PhoneAskSheetProvider value={sheet(phase)}>
            <SurfaceStateSizeProvider size="phone">
                <WorkspaceFileDetailsView scopeId="project:phone-ask-capsule" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider>
        </PhoneAskSheetProvider></ModalProvider>;
        let setPhase: (phase: 'closed' | 'open' | 'working') => void = () => {};
        function Harness() {
            const [phase, set] = React.useState<'closed' | 'open' | 'working'>('closed');
            setPhase = set;
            return page(phase);
        }
        const screen = await fixture.render(<Harness />);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
            await act(async () => { setPhase('working'); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findHostByTestId('file-page-toolbar')).toBeNull();
            await act(async () => { setPhase('closed'); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
        } finally { await screen.unmount(); }
    });

    it('seats the phone selection bar above the floating tab bar, in place of the page toolbar', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { SelectionActionBar } = await import('@/components/ui/selection/SelectionActionBar');
        const { StyleSheet } = await import('react-native');
        // The code view's DOM selection is the boundary: one selected row of the read body.
        const root = document.createElement('div');
        const line = document.createElement('div');
        line.id = 'file-view-f:1';
        line.append(document.createTextNode('export const attempts = 3;'));
        root.append(line);
        document.body.append(root);
        const range = document.createRange();
        range.selectNodeContents(line);
        range.getBoundingClientRect = () => new DOMRect(20, 30, 160, 20);
        range.getClientRects = () => [new DOMRect(20, 30, 160, 20)] as unknown as DOMRectList;
        const tabBarHeight = 84;
        const screen = await fixture.render(<ModalProvider><SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
            <SurfaceStateSizeProvider size="phone">
                <WorkspaceFileDetailsView scopeId="project:phone-selection" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider>
        </SessionCockpitBottomChromeHeightContext.Provider></ModalProvider>, { createNodeMock: node => node.type === 'View' ? root : null });
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
            await act(async () => { document.dispatchEvent(new Event('selectionchange')); });
            await vi.waitFor(() => expect(screen.findByType(SelectionActionBar).props.visible).toBe(true));
            await flushHookEffects({ cycles: 2 });
            // The floating tab bar covers the page's bottom: the bar clears it, and the page toolbar steps aside.
            expect(StyleSheet.flatten(screen.findByType(SelectionActionBar).parent?.props.style)).toMatchObject({ bottom: tabBarHeight });
            expect(screen.findHostByTestId('file-page-toolbar')).toBeNull();
            // ✕ puts the bar away until the selection changes, and the page toolbar comes back.
            await screen.pressByTestIdAsync('selection-bar-dismiss');
            await flushHookEffects({ cycles: 2 });
            expect(screen.findByType(SelectionActionBar).props.visible).toBe(false);
            expect(screen.findHostByTestId('file-page-toolbar')).not.toBeNull();
        } finally { await screen.unmount(); root.remove(); window.getSelection()?.removeAllRanges(); }
    });

    it('seats the phone selection bar above the Edit key row, so Save stays reachable while lines are selected', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const { SessionCockpitBottomChromeHeightContext } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
        const { PageBottomBarSeatProvider } = await import('@/components/ui/layout/useFloatingChromeClearance');
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const { SelectionActionBar } = await import('@/components/ui/selection/SelectionActionBar');
        const { FilePageHeader } = await import('../file/FilePageHeader');
        const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
        const { StyleSheet } = await import('react-native');
        const tabBarHeight = 84;
        const keyRowHeight = 44;
        const screen = await fixture.render(<ModalProvider><SessionCockpitBottomChromeHeightContext.Provider value={tabBarHeight}>
            <PageBottomBarSeatProvider><SurfaceStateSizeProvider size="phone">
                <WorkspaceFileDetailsView scopeId="project:phone-edit-selection" scope={fixture.scope} filePath={filePath}
                    sessionIdForAugmentation={null} />
            </SurfaceStateSizeProvider></PageBottomBarSeatProvider>
        </SessionCockpitBottomChromeHeightContext.Provider></ModalProvider>);
        try {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            // The editor engine is the platform boundary: one selected line.
            const selection = { startLine: 1, endLine: 1, text: 'export const attempts = 3;', rect: { x: 40, y: 60, width: 120, height: 18 } };
            const panel = screen.findByType(FileEditorPanel);
            (panel.props.editorRef as { current: unknown }).current = { getValue: () => svg, flushPendingChange: async () => {},
                getSelection: () => selection, subscribeSelection: () => () => {} };
            await act(async () => { panel.props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            // The key row pads by the tab bar, so its box reaches from the page's bottom to its top edge.
            const keyRow = screen.findHostByTestId('code-editor-accessory');
            expect(keyRow).not.toBeNull();
            await act(async () => { keyRow?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: tabBarHeight + keyRowHeight } } }); });
            await vi.waitFor(() => expect(screen.findByType(SelectionActionBar).props.visible).toBe(true));
            await flushHookEffects({ cycles: 2 });
            // The key row is in flow and cannot step aside; the selection's bar is the one that floats, so it rides above.
            const bottom = StyleSheet.flatten(screen.findByType(SelectionActionBar).parent?.props.style).bottom as number;
            expect(bottom).toBeGreaterThan(tabBarHeight + keyRowHeight);
        } finally { await screen.unmount(); }
    });

    it('keeps the read view up until the editor reports ready, then swaps to the editor', async () => {
        const screen = await fixture.render(<ModalProvider>
            <WorkspaceFileDetailsView scopeId="project:edit-swap" scope={fixture.scope} filePath={filePath}
                sessionIdForAugmentation={null} />
        </ModalProvider>);
        try {
            const { FilePageHeader } = await import('../file/FilePageHeader');
            const { FileContentPanel } = await import('../file/FileContentPanel');
            const { FileEditorPanel } = await import('../file/editor/FileEditorPanel');
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('retryLabel'));
            await flushHookEffects({ cycles: 4 });
            await vi.waitFor(() => expect(screen.findByType(FilePageHeader).props.edit?.kind).toBe('edit'));
            await act(async () => { screen.findByType(FilePageHeader).props.edit.onPress(); });
            await flushHookEffects({ cycles: 4 });
            // The engine is still loading (a cold Monaco has not booted): the editor mounts beneath, unseen and
            // untouchable, while the code view the person was reading stays on screen (P4 §3.5, files lab ED1).
            await vi.waitFor(() => expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1));
            expect(screen.findAllByType(FileContentPanel)).toHaveLength(1);
            const warming = screen.findByTestId('file-details-editor-warming');
            expect(warming?.props.pointerEvents).toBe('none');
            // The engine reports ready: one swap, the read view leaves and the editor is the body.
            await act(async () => { screen.findByType(FileEditorPanel).props.onReady?.(); });
            await flushHookEffects({ cycles: 2 });
            expect(screen.findAllByType(FileContentPanel)).toHaveLength(0);
            expect(screen.findByTestId('file-details-editor-warming')).toBeNull();
            expect(screen.findAllByType(FileEditorPanel)).toHaveLength(1);
        } finally { await screen.unmount(); }
    });
});
