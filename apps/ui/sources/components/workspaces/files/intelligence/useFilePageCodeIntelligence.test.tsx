import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import {
    cleanupWorkspaceFileDetailsActionBoundary, getWorkspaceFileDetailsActionBoundary, installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks, prepareWorkspaceFileDetailsActionBoundary,
} from '../details/workspaceFileDetails/workspaceFileDetailsTestHelpers';
import type { UseFilePageCodeIntelligenceInput } from './useFilePageCodeIntelligence';
import type { LanguageIntelligenceQueryInput, LanguageIntelligenceQueryResult, LanguageIntelligenceWatchResult } from '@happier-dev/protocol/machines/languageIntelligence';

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
// Only the remote Machine is scripted; the page controller, holder and Search source remain real.
const machine = vi.hoisted(() => ({ sync: vi.fn(), query: vi.fn(), watch: vi.fn(), fallback: vi.fn() }));
vi.mock('@/sync/ops/machineLanguageIntelligence', () => ({
    machineLanguageIntelligenceSync: machine.sync, machineLanguageIntelligenceQuery: machine.query,
    machineLanguageIntelligenceWatch: machine.watch, machineCodeIntelligenceFallback: machine.fallback,
    machineLanguageIntelligenceRestartAction: async () => ({ status: 'ok' }),
}));

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useFilePageCodeIntelligence } = await import('./useFilePageCodeIntelligence');
const { CodeIntelligenceCard } = await import('./CodeIntelligenceCard');
const { createWorkspaceSymbolSearchSource } = await import('@/components/appShell/search/workspaceSymbolSearchSource');
const { useWorkspaceFileEditorState } = await import('../details/workspaceFileDetails/useWorkspaceFileEditorState');
const { useWorkspaceFileEditorCommands } = await import('../details/workspaceFileDetails/useWorkspaceFileEditorCommands');
const { useCodeIntelligencePaneProducer } = await import('./codeIntelligencePaneStore');
const { registerComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { storage } = await import('@/sync/domains/state/storage');
const actionBoundary = getWorkspaceFileDetailsActionBoundary();
const scope = { serverId: '', machineId: 'm1', rootPath: '/repo' };
const server = { serverId: 'ts', label: 'TS', state: 'ready', loading: false, generation: 'g1' } as const;
const defaultLiveValue = { get: () => 'const value = Promise.resolve(1);' };
function PageWrapper({ children }: React.PropsWithChildren) { return <AppPaneProvider>{children}</AppPaneProvider>; }
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests>;

function input(overrides: Partial<UseFilePageCodeIntelligenceInput> = {}): UseFilePageCodeIntelligenceInput {
    return { scopeId: 'intelligence-page', scope, filePath: 'src/a.ts', language: 'typescript', enabled: true, active: true,
        liveValue: defaultLiveValue, getUnsaved: () => false,
        editorHandleRef: { current: null }, sessionId: null, accountId: 'account-a',
        machineName: 'Machine', machineUnreachable: false, agentName: null, ...overrides };
}

function useRetainedEditor(id: 'a' | 'b', text: string, focused: boolean) {
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);
    const editor = useWorkspaceFileEditorState({ scope, accountId: 'account-a', filePath: `src/${id}.ts`,
        displayMode: 'file', fileText: text, fileHash: `base-${id}`, fileWriteSupported: true,
        setFileWriteSupported() {}, fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true,
        filesEditorNativeCodeMirrorEnabled: true, filesEditorAutoSave: false, filesEditorChangeDebounceMs: 0,
        mountedRef, refreshAll: async () => {},
    });
    useWorkspaceFileEditorCommands({ editor, tabKey: `file:src/${id}.ts`, file: { scope, path: `src/${id}.ts` },
        serverId: scope.serverId, accountId: 'account-a', focused, onStart: editor.startEditingFile });
    return editor;
}

describe('File-page intelligence composition', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://intelligence.test' });
        portal = installReactDomPortalBoundaryForTests();
        scope.serverId = await prepareWorkspaceFileDetailsActionBoundary();
        machine.sync.mockReset().mockResolvedValue({ status: 'ok', generation: 'g1', version: 1, servers: [server] });
        machine.query.mockReset();
        machine.watch.mockReset().mockImplementation((_machine, _request, options: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })));
        machine.fallback.mockReset();
    });
    afterEach(async () => { await standardCleanup(); await cleanupWorkspaceFileDetailsActionBoundary(); portal.restore(); browser.restore(); });

    it('offers Markdown headings to passive @ Search in View, Source and Edit without starting a server', async () => {
        let text = '# First\n\n## Target';
        const liveValue = { get: () => text };
        const hook = await renderHook(({ presentation }: { presentation: 'view' | 'source' | 'edit' }) => useFilePageCodeIntelligence(input({
            filePath: 'README.md', language: 'markdown', enabled: false, outlineEnabled: true, liveValue,
            editorHandleRef: { current: presentation === 'edit' ? { getValue: () => text, flushPendingChange: async () => {} } : null },
        })), { initialProps: { presentation: 'view' }, wrapper: PageWrapper });
        for (const presentation of ['view', 'source', 'edit'] as const) {
            await hook.rerender({ presentation });
            const symbols = hook.getCurrent().symbols;
            expect(symbols).not.toBeNull();
            if (!symbols) throw new Error('Expected the active file outline');
            const page = await createWorkspaceSymbolSearchSource(symbols).resolve('Target', new AbortController().signal);
            expect(page.results[0]?.target).toMatchObject({ kind: 'workspaceSymbol', path: 'README.md', anchor: { kind: 'fileLine', startLine: 3 } });
            text = '# Updated\n\n## Target';
        }
        expect(machine.sync).not.toHaveBeenCalled();
        expect(machine.query).not.toHaveBeenCalled();
    });

    it.each(['modifier', 'cursor', 'card'] as const)('opens the existing explanation only when an outside-only definition settles (%s)', async (entry) => {
        let settle!: (result: LanguageIntelligenceQueryResult) => void;
        machine.query.mockImplementation((_machine, request: LanguageIntelligenceQueryInput) => request.kind === 'hover'
            ? Promise.resolve({ status: 'ok', kind: 'hover', sections: [] })
            : new Promise(resolve => { settle = resolve; }));
        const hook = await renderHook(() => useFilePageCodeIntelligence(input({
            editorHandleRef: { current: { getValue: () => 'const value = Promise.resolve(1);', flushPendingChange: async () => {},
                getCursorPosition: () => ({ line: 1, character: 16 }) } },
        })), { wrapper: PageWrapper });
        const before = hook.getCurrent().layer;
        expect(before).not.toBeNull();
        if (!before) throw new Error('Expected the existing card layer');
        const interaction = before.props.interaction as { getState(): unknown };
        if (entry === 'card') {
            const screen = await renderScreen(before);
            await act(async () => { hook.getCurrent().menuCommands?.['code.showInfo'](); });
            await act(async () => { screen.findAllByType(CodeIntelligenceCard)[0]?.props.onDefinition(); });
        } else await act(async () => {
            if (entry === 'modifier') hook.getCurrent().viewBinding?.onActivate(1, 16, { via: 'modifier', rect: null });
            else hook.getCurrent().menuCommands?.['code.goToDefinition']();
        });
        await vi.waitFor(() => expect(settle).toBeTypeOf('function'));
        expect(interaction.getState()).toBeNull();
        await act(async () => { settle({ status: 'ok', kind: 'definition', hasMore: false, locations: [{ serverId: 'ts',
            path: '/managed/lib.d.ts', outsideWorkspace: true,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }] }); });
        expect(hook.getCurrent().controller?.getSnapshot().status).toBe('ready');
        expect(interaction.getState()).toMatchObject({ via: 'command', references: false });
    });

    it('keeps the explanation closed for an ordinary in-workspace definition', async () => {
        machine.query.mockResolvedValue({ status: 'ok', kind: 'definition', hasMore: false, locations: [{ serverId: 'ts',
            path: 'src/definition.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }] });
        const hook = await renderHook(() => useFilePageCodeIntelligence(input()), { wrapper: PageWrapper });
        const layer = hook.getCurrent().layer;
        if (!layer) throw new Error('Expected the existing card layer');
        const interaction = layer.props.interaction as { getState(): unknown };
        await act(async () => { hook.getCurrent().viewBinding?.onActivate(1, 16, { via: 'modifier', rect: null }); });
        expect(hook.getCurrent().controller?.getSnapshot().status).toBe('ready');
        expect(interaction.getState()).toBeNull();
    });

    it.each([false, true])('asks about every open file and saves a noncurrent dirty holder first (save fails: %s)', async (saveFails) => {
        const first = 'const a = 1;\n\nmissingA();';
        const second = 'const b = 1;\n\nmissingB();';
        const savedSecond = 'const b = 2;\n\nmissingB();';
        machine.query.mockResolvedValue({ status: 'ok', kind: 'diagnostics', diagnostics: [], hasMore: false });
        const diagnostics: LanguageIntelligenceWatchResult = { status: 'ok', revision: 1, servers: [server], diagnostics:
            Object.fromEntries(['a', 'b'].map(id => [`src/${id}.ts`, { ts: { state: 'ready', version: 1, generation: 'g1', items: [{
                serverId: 'ts', path: `src/${id}.ts`, severity: 'error', message: `Unknown ${id}`,
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 8 } },
            }] } }])) };
        let deliver!: (answer: LanguageIntelligenceWatchResult) => void;
        machine.watch.mockImplementationOnce((_machine, _request, options: { signal: AbortSignal }) =>
            new Promise<LanguageIntelligenceWatchResult>((resolve, reject) => {
                deliver = resolve;
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            }));
        const events: string[] = [];
        actionBoundary.read.mockReset().mockImplementation(async () => {
            events.push('save');
            return saveFails ? { success: false, error: 'Write failed' } : { success: true, hash: 'saved-b' };
        });
        const dispose = registerComposerPresentationTarget({ kind: 'session', sessionId: 'diagnostics-session' }, {
            readRevision: () => 0, replace: () => 0, focusComposer: () => { events.push('focus'); },
        });
        const previous = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey;
        storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: {} });
        const hook = await renderHook(() => {
            const editor = useRetainedEditor('a', first, true);
            const otherEditor = useRetainedEditor('b', second, false);
            const editors = [editor, otherEditor];
            const page = useFilePageCodeIntelligence(input({ liveValue: editor.liveValue, editorHandleRef: editor.editorHandleRef,
                getUnsaved: () => editor.readSnapshot().dirty, sessionId: 'diagnostics-session' }));
            const producer = useCodeIntelligencePaneProducer('intelligence-page');
            return { page, editors, producer };
        }, { wrapper: PageWrapper });
        try {
            await act(async () => { hook.getCurrent().editors[1]!.startEditingFile(); });
            await act(async () => { hook.getCurrent().editors[1]!.onEditorChange(savedSecond); });
            expect(hook.getCurrent().page.controller).not.toBeNull();
            await act(async () => { await hook.getCurrent().page.controller?.checkProblems(); });
            await act(async () => { deliver(diagnostics); });
            expect(Object.keys(hook.getCurrent().page.controller?.getDiagnosticsProjection().entries ?? {})).toEqual(['src/a.ts', 'src/b.ts']);
            await vi.waitFor(() => expect(hook.getCurrent().producer?.ask).not.toBeNull());
            const label = hook.getCurrent().producer?.ask?.label;
            let asked = false;
            await act(async () => { asked = await hook.getCurrent().producer?.ask?.run() ?? false; });
            const drafts = Object.values(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey).flat();
            if (saveFails) {
                expect(asked).toBe(false);
                expect(drafts).toEqual([]);
                expect(events).toEqual(['save']);
            } else {
                expect(asked).toBe(true);
                expect(drafts.map(draft => [draft.filePath, draft.snapshot.selectedLines])).toEqual([
                    ['src/a.ts', ['missingA();']], ['src/b.ts', ['missingB();']],
                ]);
                expect(events).toEqual(['save', 'focus']);
            }
            expect(label).toContain('saveAndAsk');
        } finally { await hook.unmount(); dispose(); storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: previous }); }
    });
});
