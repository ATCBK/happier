import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChangedFilesReviewDiffBlock } from './ChangedFilesReviewDiffBlock';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { t } from '@/text';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { ImageCompare } from './imageCompare/ImageCompare';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const diffReviewCommentsViewerMock = vi.hoisted(() => ({
    renderCount: 0,
}));

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: {
                    OS: 'web',
                    select: (values: any) => values?.web ?? values?.default ?? null,
                },
                View: (props: any) => React.createElement('View', props, props.children),
                Image: (props: any) => React.createElement('Image', props, props.children),
                ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props, props.children),
                AppState: {
                    currentState: 'active',
                    addEventListener: () => ({ remove: () => {} }),
                },
                Dimensions: {
                    get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }),
                },
                useWindowDimensions: () => ({ width: 1200, height: 800 }),
            },
        );
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (_key: string) => true,
        });
    },
});

vi.mock('@/components/ui/code/diff/resolveInlineDiffVirtualization', () => ({
    resolveInlineDiffVirtualization: () => true,
}));

vi.mock('@/components/ui/code/diff/useInlineDiffVirtualizationThresholds', () => ({
    useInlineDiffVirtualizationThresholds: () => ({ lineThreshold: 1, byteThreshold: 1 }),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => {
        diffReviewCommentsViewerMock.renderCount += 1;
        return React.createElement('DiffReviewCommentsViewer', props);
    },
}));

describe('ChangedFilesReviewDiffBlock', () => {
    it.each(['deleted.png', 'deleted.svg'])('renders %s as a truthful captured image even with a nonempty patch', async (filePath) => {
        const source = createChangedFilesReviewDiffStateSource();
        const diff = filePath.endsWith('.svg') ? '@@ -1 +0,0 @@\n-<svg />\n' : `Binary files a/${filePath} and /dev/null differ\n`;
        source.setDiffState(filePath, { status: 'loaded', diff, error: null });
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64), source: { kind: 'session', sessionId: 's1' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
                path: filePath, changeKind: 'deleted', binary: !filePath.endsWith('.svg'), generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: diff }, occurrences: [],
            }] } });
        const screen = await renderScreen(<ChangedFilesReviewDiffBlock theme={createThemeFixture()} sessionId="s1"
            snapshotSignature="sig" filePath={filePath} diffStateSource={source} reviewCommentsEnabled={false} reviewCommentDrafts={[]}
            evidenceOnly workspaceScope={{ serverId: 'home', machineId: 'machine', rootPath: '/repo' }}
            imageCompare={{ kind: 'captured', comparisonId: comparison.id, file: comparison.inventory.files[0]! }} />);
        expect(screen.tree.root.findByType(ImageCompare).props.after.kind).toBe('deleted');
        expect(screen.tree.root.findAllByType('DiffViewer' as never)).toHaveLength(filePath.endsWith('.svg') ? 1 : 0);
    });
    beforeEach(() => {
        diffReviewCommentsViewerMock.renderCount = 0;
    });

    it('updates an opaque unknown file when its SCM binary metadata arrives', async () => {
        const diffStateSource = createChangedFilesReviewDiffStateSource();
        diffStateSource.setDiffState('unknown.asset', { status: 'loaded', diff: '', error: null });
        const props = {
            theme: createThemeFixture(), sessionId: 's1', snapshotSignature: 'sig',
            filePath: 'unknown.asset', diffStateSource, reviewCommentsEnabled: false,
            reviewCommentDrafts: [],
        };
        const screen = await renderScreen(<ChangedFilesReviewDiffBlock {...props} />);
        expect(screen.getTextContent()).toContain(t('files.noChanges'));
        await screen.update(<ChangedFilesReviewDiffBlock {...props} isBinaryContent />);
        expect(screen.getTextContent()).toContain(t('files.binaryFile'));
        expect(screen.getTextContent()).not.toContain(t('files.noChanges'));
    });

    // Recognised media wins over git's binary flag (P2 §3.2): a changed recording names its kind, not
    // "Binary File", and opens the File page that plays it.
    it.each(['assets/intro-loop.mp4', 'assets/chime.wav'])('reads a changed recording (%s) as its kind and opens its File page', async (filePath) => {
        const diffStateSource = createChangedFilesReviewDiffStateSource();
        diffStateSource.setDiffState(filePath, { status: 'loaded', diff: '', error: null });
        const onOpenFile = vi.fn();
        const { resolveFileViewerKind } = await import('@/scm/utils/filePresentation');
        const kindLabel = t(resolveFileViewerKind({ path: filePath }).labelKey as never) as string;
        const screen = await renderScreen(<ChangedFilesReviewDiffBlock theme={createThemeFixture()} sessionId="s1" snapshotSignature="sig"
            filePath={filePath} diffStateSource={diffStateSource} reviewCommentsEnabled={false} reviewCommentDrafts={[]}
            isBinaryContent onOpenFile={onOpenFile} />);
        expect(screen.getTextContent()).not.toContain(t('files.binaryFile'));
        expect(screen.getTextContent()).toContain(kindLabel);
        await screen.pressByTestIdAsync('scm-review-media-open');
        expect(onOpenFile).toHaveBeenCalledWith(filePath);
    });

    it('reserves a fixed height while loading for large diffs (prevents scroll jumps)', async () => {
        const loadingState = { status: 'loading', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadingState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = createThemeFixture({
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        }) as any;

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    estimatedChangedLines={2}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />)).tree;

        // Loading UI should include a container that reserves height (to reduce scroll jumps).
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const views = tree!.findAllByType('View' as any);
        const hasHeightReservation = views.some((view) => {
            const style = view.props.style;
            const arr = Array.isArray(style) ? style : [style];
            return arr.some((entry) => entry && typeof entry === 'object' && typeof entry.height === 'number' && entry.height > 0);
        });
        expect(hasHeightReservation).toBe(true);
    });

    it('bounds loaded virtualized diffs with explicit height so native lists do not collapse', async () => {
        const loadedState = { status: 'loaded', diff: '@@ -1 +1 @@\n-old\n+new', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadedState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = createThemeFixture({
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        }) as any;

        const screen = await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />);

        const boundedContainers = screen.findAll((node) => {
            const styles = Array.isArray(node.props?.style) ? node.props.style : [node.props?.style];
            return String(node.type) === 'View'
                && styles.some((entry) => entry && typeof entry === 'object' && typeof (entry as any).maxHeight === 'number');
        });
        expect(boundedContainers).toHaveLength(1);
        const styles = Array.isArray(boundedContainers[0].props.style)
            ? boundedContainers[0].props.style
            : [boundedContainers[0].props.style];
        const boundedStyle = styles.find((entry) => entry && typeof entry === 'object' && typeof (entry as any).maxHeight === 'number') as any;
        expect(boundedStyle.height).toBe(boundedStyle.maxHeight);
    });

    it('does not reserve the max diff height while loading for small diffs (avoids blank whitespace gaps)', async () => {
        const loadingState = { status: 'loading', diff: '', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadingState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = createThemeFixture({
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        }) as any;

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    estimatedChangedLines={0}
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={false}
                    reviewCommentDrafts={[]}
                />)).tree;

        // Loading UI should not reserve the large virtualized height for small diffs.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const views = tree!.findAllByType('View' as any);
        const reservedHeights = views
            .map((view) => view.props.style)
            .flatMap((style) => (Array.isArray(style) ? style : [style]))
            .filter((entry) => entry && typeof entry === 'object' && typeof (entry as any).height === 'number')
            .map((entry) => (entry as any).height as number);

        // The max virtualized height for this test window is ~440px; assert we don't reserve that.
        expect(reservedHeights.some((height) => height >= 400)).toBe(false);
    });

    it('does not rerender the diff viewer when only unrelated review drafts change', async () => {
        const loadedState = { status: 'loaded', diff: '@@ -1 +1 @@\n-old\n+new', error: null } as const;
        const diffStateSource = {
            getDiffState: () => loadedState,
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        } as any;

        const theme = createThemeFixture({
            colors: {
                border: { default: '#333' },
                surface: { base: '#000', inset: '#111' },
                text: { secondary: '#999' },
            },
        }) as any;

        const unrelatedDraft: ReviewCommentDraft = {
            id: 'draft-1',
            filePath: 'src/b.ts',
            source: 'diff',
            anchor: { kind: 'diffLine', startLine: 1, side: 'after', oldLine: null, newLine: 1 },
            snapshot: { selectedLines: [], beforeContext: [], afterContext: [] },
            body: 'first',
            createdAt: 1,
        };

        const screen = await renderScreen(<ChangedFilesReviewDiffBlock
                    theme={theme}
                    sessionId="s1"
                    snapshotSignature="sig"
                    filePath="src/a.ts"
                    diffStateSource={diffStateSource}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={[unrelatedDraft]}
                />);

        expect(diffReviewCommentsViewerMock.renderCount).toBe(1);

        await screen.update(<ChangedFilesReviewDiffBlock
                        theme={theme}
                        sessionId="s1"
                        snapshotSignature="sig"
                        filePath="src/a.ts"
                        diffStateSource={diffStateSource}
                        reviewCommentsEnabled={true}
                        reviewCommentDrafts={[{ ...unrelatedDraft, body: 'changed elsewhere' }]}
                    />);

        expect(diffReviewCommentsViewerMock.renderCount).toBe(1);

        await screen.update(<ChangedFilesReviewDiffBlock
                        theme={theme}
                        sessionId="s1"
                        snapshotSignature="sig"
                        filePath="src/a.ts"
                        diffStateSource={diffStateSource}
                        reviewCommentsEnabled={true}
                        reviewCommentDrafts={[{ ...unrelatedDraft, filePath: 'src/a.ts' }]}
                    />);

        expect(diffReviewCommentsViewerMock.renderCount).toBe(2);
    });

    it('draws Explain notes beside the code, never inside the diff renderer, which clips its own box', async () => {
        const diff = '@@ -1,2 +1,2 @@\n ctx\n-old\n+new';
        const loadedState = { status: 'loaded', diff, error: null } as const;
        const diffStateSource = { getDiffState: () => loadedState, subscribe: () => () => {}, reset: () => {}, prune: () => {},
            setDiffState: () => {}, updateDiffState: () => {} } as any;
        const theme = createThemeFixture({ colors: { border: { default: '#333' }, surface: { base: '#000', inset: '#111' }, text: { secondary: '#999' } } }) as any;
        const render = vi.fn((_path: string, hunkIndex: number) => React.createElement('View', { testID: `note-${hunkIndex}` }));
        const screen = await renderScreen(<ChangedFilesReviewDiffBlock theme={theme} sessionId="s1" snapshotSignature="sig" filePath="src/a.ts"
            diffStateSource={diffStateSource} reviewCommentsEnabled={false} reviewCommentDrafts={[]}
            hunkNotes={{ placement: 'column', columnWidth: 320, render }} />);
        const viewer = screen.findAll((node) => String(node.type) === 'DiffViewer')[0]!;
        const { buildDiffHunkTable } = await import('@/components/ui/code/diff/hunks/buildDiffHunkTable');
        const hunk = buildDiffHunkTable({ mode: 'unified', filePath: 'src/a.ts', unifiedDiff: diff }).hunks[0]!;
        const drawnInside = viewer.props.hunks.renderNote(hunk) as React.ReactElement<{ onMeasure: (index: number, y: number) => void }> | null;
        const containsNote = (node: unknown): boolean => {
            if (!React.isValidElement(node)) return Array.isArray(node) && node.some(containsNote);
            const props = node.props as { testID?: string; children?: unknown };
            return props.testID === 'note-0' || containsNote(props.children);
        };
        // What the renderer paints inside its own box carries no note.
        expect(containsNote(drawnInside)).toBe(false);
        // Once the platform reports where the hunk starts, the note stands in the block's own column.
        await renderer.act(async () => { drawnInside!.props.onMeasure(0, 40); });
        const note = screen.findAll((node) => node.props?.testID === 'note-0' && typeof node.type === 'string')[0];
        expect(note).toBeTruthy();
        let insideViewer = false;
        for (let parent = note!.parent; parent; parent = parent.parent) if (String(parent.type) === 'DiffViewer') insideViewer = true;
        expect(insideViewer).toBe(false);
    });
    it('names a new empty file as empty, not as unchanged', async () => {
        const state = { status: 'loaded', diff: '', error: null, emptyFile: true } as const;
        const diffStateSource = { getDiffState: () => state, subscribe: () => () => {}, reset: () => {}, prune: () => {},
            setDiffState: () => {}, updateDiffState: () => {} } as any;
        const theme = createThemeFixture({ colors: { border: { default: '#333' }, surface: { base: '#000', inset: '#111' }, text: { secondary: '#999' } } }) as any;
        const screen = await renderScreen(<ChangedFilesReviewDiffBlock theme={theme} sessionId="s1" snapshotSignature="sig"
            filePath="docs/getting-started.md" estimatedChangedLines={0} diffStateSource={diffStateSource}
            reviewCommentsEnabled={false} reviewCommentDrafts={[]} />);
        expect(screen.getTextContent()).toContain('Empty file');
        expect(screen.getTextContent()).not.toContain('No changes to display');
    });
});
