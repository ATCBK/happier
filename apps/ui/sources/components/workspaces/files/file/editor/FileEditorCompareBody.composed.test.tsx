// @vitest-environment jsdom

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { buildDiffHunkTable } from '@/components/ui/code/diff/hunks/buildDiffHunkTable';
import type { DiffViewerProps } from '@/components/ui/code/diff/diffViewerTypes';
import { BrowserWorker } from '@/components/ui/code/diff/pierre/pierreWorkerTestHelpers';
import {
    useWorkspaceFileEditorComparison,
    type EditorComparisonResolution,
} from '@/components/workspaces/files/details/workspaceFileDetails/useWorkspaceFileEditorComparison';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Only Pierre's third-party DOM paint boundary is replaced. Its real host builds
// the annotations and the real DiffViewer binds the canonical hunk slots.
vi.mock('@pierre/diffs/react', async importOriginal => {
    const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
    return { ...actual,
        FileDiff: (props: React.ComponentProps<typeof actual.FileDiff>) => React.createElement(
            'pierre-file-diff', props,
            props.lineAnnotations?.map((annotation, index) => <React.Fragment key={index}>
                {props.renderAnnotation?.(annotation)}
            </React.Fragment>),
        ),
        Virtualizer: ({ children }: React.PropsWithChildren) => <>{children}</>,
    };
});

const { FileEditorCompareBody } = await import('./FileEditorCompareBody');
const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
const { DiffViewer: WebDiffViewer } = await import('@/components/ui/code/diff/DiffViewer.web');
const initialState = storage.getState();
const draft = 'a\na\nb\na\nc\n';
const disk = 'b\na\nb\n';

describe('editor Compare displayed-place choices', () => {
    beforeEach(() => {
        BrowserWorker.reset();
        vi.stubGlobal('Worker', BrowserWorker);
        storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'pierre' } });
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
        vi.unstubAllGlobals();
    });

    it.each(['happier', 'pierre'] as const)('keeps every repeated-line place and its exact choice on %s', async renderer => {
        const accepted: EditorComparisonResolution[] = [];
        const hook = await renderHook(() => useWorkspaceFileEditorComparison({ ownerKey: 'file', onAccept: value => accepted.push(value) }));
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText: draft, theirsText: disk, theirsHash: 'shown-disk' }));
        const original = hook.getCurrent().comparison!;
        expect(original.places).toHaveLength(3);
        const body = () => <FileEditorCompareBody comparison={hook.getCurrent().comparison!} agentName={null} filePath="a.ts"
            onUsePlaceMine={hook.getCurrent().usePlaceMine} onUsePlaceTheirs={hook.getCurrent().usePlaceTheirs}
            onUseAllMine={hook.getCurrent().useAllMine} onUseAllTheirs={hook.getCurrent().useAllTheirs}
            onBackToEditing={hook.getCurrent().backToEditing} />;
        const screen = await renderScreen(body());
        const diffProps = () => screen.findAllByType(DiffViewer)[0]!.props as DiffViewerProps;
        const table = buildDiffHunkTable(diffProps());
        expect(table.hunks.map(hunk => [hunk.hunkIndex, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual(
            original.places.map(({ hunk }) => [hunk.index, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
        );
        // Vitest resolves the portable entry. Feed its actual consumer props into
        // the real web wrapper to exercise the Pierre platform seam as well.
        const web = renderer === 'pierre' ? await renderScreen(<WebDiffViewer {...diffProps()} />) : null;
        await act(async () => { await vi.dynamicImportSettled(); });
        const displayed = web ?? screen;
        if (web) expect(web.findAllByType('pierre-file-diff')).toHaveLength(1);
        for (const place of original.places) {
            expect(displayed.findHostByTestId(`file-editor-compare-place-${place.hunk.index}`)).not.toBeNull();
        }
        await displayed.pressByTestIdAsync('file-editor-compare-place-2-theirs');
        expect(hook.getCurrent().comparison?.mergedText).toBe('a\na\nb\n');
        await screen.update(body());
        if (web) await web.update(<WebDiffViewer {...diffProps()} />);
        expect(buildDiffHunkTable(diffProps()).hunks).toEqual(table.hunks);
        await displayed.pressByTestIdAsync('file-editor-compare-place-0-mine');
        await displayed.pressByTestIdAsync('file-editor-compare-place-1-mine');
        expect(accepted).toEqual([{ text: 'a\na\nb\n', baseText: disk, baseHash: 'shown-disk' }]);
    });
});
