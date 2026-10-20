// @vitest-environment jsdom

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { storage } from '@/sync/domains/state/storageStore';
import type { DiffHunkInfo } from './diffViewerTypes';
import { DiffHunksRenderer, getLineAnnotationName } from '@pierre/diffs';
import type { FileDiffProps } from '@pierre/diffs/react';
import { BrowserWorker } from './pierre/pierreWorkerTestHelpers';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Pierre owns DOM painting. Keep its parser, annotation adapter, and the host wrapper real.
vi.mock('@pierre/diffs/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
    return {
        ...actual,
        Virtualizer: ({ children }: React.PropsWithChildren) => <>{children}</>,
        FileDiff: (props: React.ComponentProps<typeof actual.FileDiff>) => React.createElement('pierre-file-diff', props,
            props.lineAnnotations?.map((annotation, index) => <React.Fragment key={index}>
                {props.renderAnnotation?.(annotation)}
            </React.Fragment>)),
    };
});

const PATCH = '--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n first\n-before\n+after\n middle\n-old\n+new\n last\n';
const initialState = storage.getState();

async function expectFileAnnotationBeforeCode(props: FileDiffProps<React.ReactNode, undefined>) {
    const renderer = new DiffHunksRenderer<React.ReactNode>({ ...props.options, theme: 'pierre-light' });
    try {
        // Pass the real host adapter's output into Pierre's real renderer, beyond the DOM paint mock.
        renderer.setLineAnnotations(props.lineAnnotations ?? []);
        const rendered = await renderer.asyncRender(props.fileDiff);
        const host = document.createElement('div');
        host.innerHTML = renderer.renderFullHTML(rendered);
        const annotation = props.lineAnnotations?.find((entry) => entry.lineNumber === 0);
        expect(annotation).toBeDefined();
        const slot = host.querySelector(`slot[name="${getLineAnnotationName(annotation!)}"]`);
        expect(slot).not.toBeNull();
        const column = slot!.closest('code') ?? host;
        const firstContent = column.querySelector('[data-line]');
        expect(firstContent).not.toBeNull();
        expect(slot!.compareDocumentPosition(firstContent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const separator = column.querySelector('[data-separator]');
        if (separator) expect(slot!.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
        renderer.cleanUp();
    }
}

describe.each(['happier', 'pierre'] as const)('DiffViewer shared hunk contract (%s)', (engine) => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        // A working worker transport: a throwing one now (correctly) routes Pierre to its Happier fallback.
        BrowserWorker.reset();
        vi.stubGlobal('Worker', BrowserWorker);
        storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: engine } });
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
        browser.restore();
    });

    it('publishes review units, preserves caller content and notes, and retains destinations across state changes', async () => {
        if (engine === 'pierre') await import('./pierre/PierreDiffViewer.web');
        const { DiffViewer } = await import('./DiffViewer.web');
        const onHunks = vi.fn<(hunks: readonly DiffHunkInfo[]) => void>();
        const renderNote = (hunk: DiffHunkInfo) => <>{`note-${hunk.index};`}</>;
        const caller = () => <>comment;</>;
        const screen = await renderScreen(<DiffViewer mode="unified" virtualized={false} filePath="a.ts" unifiedDiff={PATCH}
            renderAfterLine={caller} hunks={{ onHunks, renderNote, currentIndex: 0 }} />);
        const table = onHunks.mock.calls.at(-1)?.[0];
        expect(screen.findAll((node) => node.type === 'pierre-file-diff').length > 0).toBe(engine === 'pierre');
        expect(table?.map((hunk) => hunk.firstChangeLineId)).toEqual(['r:4', 'r:7']);
        expect(screen.getTextContent()).toContain('note-0;');
        expect(screen.getTextContent()).toContain('note-1;');
        expect(screen.getTextContent()).toContain('comment;');
        await screen.update(<DiffViewer mode="unified" virtualized={false} filePath="a.ts" unifiedDiff={PATCH}
            renderAfterLine={caller} scrollToLineId={table![1]!.firstChangeLineId}
            hunks={{ onHunks, renderNote, currentIndex: 1, stateOf: () => 'kept' }} />);
        expect(onHunks.mock.calls.at(-1)?.[0]).toBe(table);
    });

    it('retains the first annotation when a hunk starts with a change', async () => {
        if (engine === 'pierre') await import('./pierre/PierreDiffViewer.web');
        const { DiffViewer } = await import('./DiffViewer.web');
        const screen = await renderScreen(<DiffViewer mode="unified" virtualized={false} filePath="a.ts"
            unifiedDiff={'--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n'}
            hunks={{ renderNote: () => <>first-change-note;</> }} />);
        expect(screen.findAll((node) => node.type === 'pierre-file-diff').length > 0).toBe(engine === 'pierre');
        expect(screen.getTextContent()).toContain('first-change-note;');
        if (engine === 'pierre') await expectFileAnnotationBeforeCode(screen.findAll((node) => node.type === 'pierre-file-diff')[0]!.props);
    });

    it('uses text-mode line identities for hunk notes', async () => {
        if (engine === 'pierre') await import('./pierre/PierreDiffViewer.web');
        const { DiffViewer } = await import('./DiffViewer.web');
        const onHunks = vi.fn<(hunks: readonly DiffHunkInfo[]) => void>();
        const screen = await renderScreen(<DiffViewer mode="text" virtualized={false} filePath="a.ts"
            oldText={'first\nbefore\nmiddle\nold\nlast\n'} newText={'first\nafter\nmiddle\nnew\nlast\n'}
            hunks={{ onHunks, renderNote: (hunk) => <>{`text-note-${hunk.index};`}</> }} />);
        expect(screen.findAll((node) => node.type === 'pierre-file-diff').length > 0).toBe(engine === 'pierre');
        expect(onHunks.mock.calls.at(-1)?.[0].map((hunk) => hunk.firstChangeLineId)).toEqual(['tr:0:1', 'tr:0:4']);
        expect(screen.getTextContent()).toContain('text-note-0;');
        expect(screen.getTextContent()).toContain('text-note-1;');
    });

    it.each([
        ['added', '--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new\n', 'additions'],
        ['deleted', '--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n', 'deletions'],
    ] as const)('keeps the file-level annotation on the rendered side of an %s file', async (_kind, unifiedDiff, side) => {
        if (engine === 'pierre') await import('./pierre/PierreDiffViewer.web');
        const { DiffViewer } = await import('./DiffViewer.web');
        const screen = await renderScreen(<DiffViewer mode="unified" virtualized={false} filePath="a.ts"
            unifiedDiff={unifiedDiff} hunks={{ renderNote: () => <>file-note;</> }} />);
        expect(screen.getTextContent()).toContain('file-note;');
        if (engine === 'pierre') {
            const viewer = screen.findAll((node) => node.type === 'pierre-file-diff')[0]!;
            expect(viewer.props.lineAnnotations).toEqual([expect.objectContaining({ side, lineNumber: 0 })]);
            await expectFileAnnotationBeforeCode(viewer.props);
        }
    });

    it('merges a later header slot with caller content on the preceding content row', async () => {
        if (engine === 'pierre') await import('./pierre/PierreDiffViewer.web');
        const { DiffViewer } = await import('./DiffViewer.web');
        const screen = await renderScreen(<DiffViewer mode="unified" virtualized={false} filePath="a.ts"
            unifiedDiff={'--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n@@ -10 +10 @@\n-old\n+new\n'}
            renderAfterLine={(line) => line.renderCodeText === 'after' ? <>caller-note;</> : null}
            hunks={{ renderNote: (hunk) => <>{`hunk-note-${hunk.index};`}</> }} />);
        expect(screen.getTextContent()).toContain('caller-note;');
        expect(screen.getTextContent()).toContain('hunk-note-0;');
        expect(screen.getTextContent()).toContain('hunk-note-1;');
        if (engine === 'pierre') {
            const viewer = screen.findAll((node) => node.type === 'pierre-file-diff')[0]!;
            expect(viewer.props.lineAnnotations).toEqual([
                expect.objectContaining({ side: 'additions', lineNumber: 0 }),
                expect.objectContaining({ side: 'additions', lineNumber: 1 }),
            ]);
        }
    });
});
