// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { installCodeViewCommonModuleMocks } from '../../view/codeViewTestHelpers';
import { buildCodeLinesFromUnifiedDiff } from '../../model/buildCodeLinesFromUnifiedDiff';
import { act } from 'react-test-renderer';

installCodeViewCommonModuleMocks();
// The third-party renderer is a boundary; renderer selection, diff parsing,
// folding, settings subscriptions, and Find decoration all stay real.
vi.mock('@pierre/diffs/react', async (importOriginal) => ({
    ...await importOriginal<typeof import('@pierre/diffs/react')>(),
    FileDiff: () => React.createElement('pierre-file-diff', { testID: 'pierre-file-diff' }),
}));
const initialSettings = storage.getState().settings;
beforeEach(() => storage.setState({ settings: { ...initialSettings, filesDiffFoldingEnabled: true,
    filesDiffFoldingContextThreshold: 4, filesDiffFoldingContextRadius: 1 } }));
afterEach(() => {
    storage.setState({ settings: initialSettings });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('unified diff Find reveal', () => {
    it('renders real line matches while Find replaces Pierre and restores the saved renderer on close', async () => {
        // jsdom supplies shadow DOM but cannot launch browser workers.
        vi.stubGlobal('Worker', class { constructor() { throw new Error('Browser worker unavailable in host test'); } });
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED', 'true');
        storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'pierre' } });
        const { DiffViewer } = await import('../DiffViewer.web');
        await import('../pierre/PierreDiffViewer.web');
        const unifiedDiff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+needle';
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff }).find(line => line.renderCodeText === 'needle')!;
        const props = { mode: 'unified' as const, unifiedDiff, filePath: 'a.ts', virtualized: false };
        const screen = await renderScreen(<DiffViewer {...props} findActive scrollToLineId={target.id}
            findRangesByLineId={new Map([[target.id, [{ start: 0, end: 6, current: true }]]])} />);
        expect(screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('')).toBe('needle');
        expect(screen.findByTestId('pierre-file-diff')).toBeNull();
        await screen.update(<DiffViewer {...props} findActive={false} />);
        expect(screen.findByTestId('pierre-file-diff')).not.toBeNull();
        expect(storage.getState().settings.filesDiffRendererMode).toBe('pierre');
    });
    it('opens the context region holding the current match through the canonical fold owner', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const unifiedDiff = ['@@ -1,11 +1,11 @@', ...Array.from({ length: 10 }, (_, index) => ` context ${index}`), '-old', '+new'].join('\n');
        const target = buildCodeLinesFromUnifiedDiff({ unifiedDiff }).find((line) => line.renderCodeText === 'context 5')!;
        const screen = await renderScreen(<HappierUnifiedDiffViewer mode="unified" unifiedDiff={unifiedDiff}
            virtualized={false} findActive={true} scrollToLineId={target.id}
            findRangesByLineId={new Map([[target.id, [{ start: 0, end: target.renderCodeText.length, current: true }]]])} />);
        const current = screen.tree.root.findAll((node) => node.props.testID === 'find-match-current');
        expect(current.length).toBeGreaterThan(0);
        expect(current[current.length - 1].children.join('')).toBe('context 5');
        const foldAgain = screen.findByTestId('diff-find-fold-again');
        expect(foldAgain).not.toBeNull();
        await act(async () => { await screen.pressByTestId('diff-find-fold-again'); });
        expect(screen.tree.root.findAll((node) => node.props.testID === 'find-match-current')).toHaveLength(0);
        expect(storage.getState().settings.filesDiffFoldingEnabled).toBe(true);
        expect(storage.getState().settings.filesDiffFoldingContextThreshold).toBe(4);
        expect(storage.getState().settings.filesDiffFoldingContextRadius).toBe(1);
    });
});
