import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { CodeLinesView, type CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const initialState = storage.getState();
const codeLinesViewType = Reflect.get(CodeLinesView, 'type') ?? CodeLinesView;

function viewProps(screen: Awaited<ReturnType<typeof renderScreen>>): CodeLinesViewProps {
    const view = screen.findAllByType(codeLinesViewType)[0];
    if (!view) throw new Error('Expected the real CodeLinesView');
    return view.props;
}

function buildDemoUnifiedDiff(): string {
    return ['@@ -1,15 +1,15 @@', ...Array.from({ length: 10 }, (_, index) => ` line${index + 1}`),
        '-line11', '+line11changed', ...Array.from({ length: 4 }, (_, index) => ` line${index + 12}`), ''].join('\n');
}

describe('HappierUnifiedDiffViewer (folding)', () => {
    beforeEach(() => {
        storage.setState({ settings: { ...storage.getState().settings, filesDiffFoldingEnabled: true,
            filesDiffFoldingContextThreshold: 6, filesDiffFoldingContextRadius: 2, filesDiffSyntaxHighlightingMode: 'off' } });
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState, true);
    });

    it('keeps folds and caller content together when hunk review and comments are active', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const caller = vi.fn((line: CodeLine) => <React.Fragment key={line.id}>comment</React.Fragment>);
        const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={buildDemoUnifiedDiff()}
            hunks={{}} renderAfterLine={caller} onPressAddComment={() => {}} isCommentActive={() => false} />);
        const props = viewProps(screen);
        expect(props.lines.some((line) => line.renderCodeText === 'line5')).toBe(false);
        const line = props.lines.find((line) => line.renderCodeText === 'line2')!;
        const content = await renderScreen(<>{props.renderAfterLine?.(line)}</>);
        expect(caller).toHaveBeenCalledWith(line);
        expect(content.findAll((node) => typeof node.props?.onPressExpand === 'function')).toHaveLength(1);
    });

    it('keeps an active comment visible while another context region stays folded', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const patch = buildDemoUnifiedDiff().replace('15 +1,15', '25 +1,25')
            + Array.from({ length: 10 }, (_, index) => ` line${index + 16}\n`).join('');
        const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={patch}
            onPressAddComment={() => {}} isCommentActive={(line) => line.renderCodeText === 'line5'}
            renderAfterLine={(line) => line.renderCodeText === 'line5' ? <>active-comment</> : null} />);
        expect(viewProps(screen).lines.some((line) => line.renderCodeText === 'line5')).toBe(true);
        expect(viewProps(screen).lines.some((line) => line.renderCodeText === 'line20')).toBe(false);
        expect(screen.getTextContent()).toContain('active-comment');
    });

    it('does not claim Find opened a passage already held open by a comment', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        let refold: (() => string) | undefined;
        await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={buildDemoUnifiedDiff()}
            isCommentActive={(line) => line.renderCodeText === 'line5'} findActive scrollToLineId="c:5"
            registerFindRefold={(handler) => { refold = handler; return () => {}; }} />);
        expect(refold?.()).toBe('noRevealedFold');
    });

    it('collapses long context blocks when folding is enabled', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={buildDemoUnifiedDiff()} filePath="src/demo.ts" />);
        const texts = viewProps(screen).lines.map((line) => line.renderCodeText);
        expect(texts).toEqual(expect.arrayContaining(['line1', 'line2', 'line9', 'line10']));
        expect(texts).not.toContain('line3');
        expect(texts).not.toContain('line8');
    });

    it.each([false, true])('preserves expanded passages through patch shifts and resets for another file (repeated: %s)', async (repeated) => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const demo = buildDemoUnifiedDiff().replace('15 +1,15', '25 +1,25')
            + Array.from({ length: 10 }, (_, index) => ` line${index + 16}\n`).join('');
        const patch = repeated ? demo.replace(/ line[3-8]\n/g, ' repeated\n') : demo;
        const passage = repeated ? 'repeated' : 'line5';
        const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={patch} filePath="src/demo.ts" />);
        const props = viewProps(screen);
        const line = props.lines.find((line) => line.renderCodeText === 'line2')!;
        const toggle = props.renderAfterLine?.(line) as React.ReactElement<{ onPressExpand: () => void }>;
        await act(async () => { toggle.props.onPressExpand(); });
        expect(viewProps(screen).lines.some((line) => line.renderCodeText === passage)).toBe(true);

        const shifted = patch.replace('@@ -1,25 +1,25 @@', '@@ -1,25 +1,28 @@\n+insertedA\n+insertedB') + '+new ending\n';
        await screen.update(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={shifted} filePath="src/demo.ts" />);
        expect(viewProps(screen).lines.some((line) => line.renderCodeText === passage)).toBe(true);
        expect(viewProps(screen).lines.some((line) => line.renderCodeText === 'line20')).toBe(false);
        await screen.update(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={shifted} filePath="src/other.ts" />);
        expect(viewProps(screen).lines.some((line) => line.renderCodeText === passage)).toBe(false);
    });

    it('uses precomputed unified diff lines when provided', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const precomputedLines: readonly CodeLine[] = [{ id: 'a:1', sourceIndex: 0, hunkIndex: null, kind: 'add',
            oldLine: null, newLine: 1, renderPrefixText: '+', renderCodeText: 'from precomputed lines',
            renderIsHeaderLine: false, selectable: true }];
        const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={buildDemoUnifiedDiff()}
            filePath="src/demo.ts" precomputedLines={precomputedLines} />);
        expect(viewProps(screen).lines.map((line) => line.renderCodeText)).toEqual(['from precomputed lines']);
    });

    it('passes inactive comment affordance visibility to the code lines view', async () => {
        const { HappierUnifiedDiffViewer } = await import('./HappierUnifiedDiffViewer');
        const screen = await renderScreen(<HappierUnifiedDiffViewer virtualized={false} mode="unified" unifiedDiff={buildDemoUnifiedDiff()}
            filePath="src/demo.ts" showInactiveCommentAffordance={false} />);
        expect(viewProps(screen).showInactiveCommentAffordance).toBe(false);
    });
});
