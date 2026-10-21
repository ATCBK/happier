/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScmReviewedMarksRecordPort, ScmReviewedMarksRecordSchema } from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { useReviewKeyboard } from './useReviewKeyboard';
import { useHunkReviewController } from './useHunkReviewController';
import { buildEditorChangeMarkers } from '@/components/ui/code/editor/editorChangeMarkers';
import { useEditorChangeMarkers } from '@/components/ui/code/editor/useEditorChangeMarkers';
import type { EditorDecoration, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const initialSettings = storage.getState().settings;
afterEach(() => { standardCleanup(); storage.setState({ settings: initialSettings }); });
const patch = '@@ -1,3 +1,3 @@\n-old\n+new\n middle\n-before\n+after\n';

describe('hunk review through the shared keyboard and Account port', () => {
    it('retains unchanged file units while neighboring diffs load and the reading file changes', async () => {
        const generated = '@@ -0,0 +1,11035 @@\n' + Array.from({ length: 11035 }, (_, index) => `+export const value${index} = ${index};\n`).join('');
        const marks = { record: null, unavailableReason: null, setReviewed: () => {}, clear: () => {}, setReviewedKeys: () => {} };
        let files = [{ path: 'generated.ts', unifiedDiff: generated }, { path: 'other.ts', unifiedDiff: '' }];
        let path = 'generated.ts';
        let controller!: ReturnType<typeof useHunkReviewController>;
        function Review() {
            controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path,
                unifiedDiff: files.find(file => file.path === path)!.unifiedDiff, liveFiles: files, host: null, serverId: null, marks });
            return null;
        }
        const screen = await renderScreen(<Review />);
        const generatedUnits = controller.reviewUnitsForPath('generated.ts');
        expect(generatedUnits).toHaveLength(1);
        expect(generatedUnits[0]!.hunk.newLines).toBe(11035);
        files = [files[0]!, { path: 'other.ts', unifiedDiff: patch }];
        const updateStarted = performance.now();
        await screen.update(<Review />);
        console.info('review-controller-neighbor-load', JSON.stringify({ lines: 11035, milliseconds: performance.now() - updateStarted }));
        expect(controller.reviewUnitsForPath('generated.ts')).toBe(generatedUnits);
        path = 'other.ts';
        await screen.update(<Review />);
        expect(controller.reviewUnitsForPath('generated.ts')).toBe(generatedUnits);
        const otherUnits = controller.reviewUnitsForPath('other.ts');
        files = [files[0]!, { path: 'other.ts', unifiedDiff: patch.replace('+new', '+updated') }];
        await screen.update(<Review />);
        expect(controller.reviewUnitsForPath('generated.ts')).toBe(generatedUnits);
        expect(controller.reviewUnitsForPath('other.ts')).not.toBe(otherUnits);
        expect(controller.reviewUnitsForPath('other.ts')[0]!.key).not.toBe(otherUnits[0]!.key);
    });
    it('binds a tracked gutter change to review actions and reverts dirty text as one undoable edit', async () => {
        const marker = buildEditorChangeMarkers('a.ts', null, patch)[0]!;
        let text = 'inserted\nnew\nmiddle\nafter\n';
        const history: string[] = [];
        let press: ((layer: 'change' | 'diagnostic' | 'blame', item: EditorDecoration) => void) | undefined;
        let replaceCount = 0;
        // The engine handle is the external editor boundary. The review owner and draft hunk engine stay real.
        const engine: TextEditorHandle = {
            getValue: () => text, flushPendingChange: async () => {},
            setDecorations: () => {},
            onDecorationPress: callback => { press = callback; return () => { press = undefined; }; },
            runCommand: command => {
                if (typeof command === 'object' && 'replaceDocument' in command) {
                    history.push(text); text = command.replaceDocument; replaceCount += 1;
                } else if (command === 'undo') text = history.pop() ?? text;
            },
        };
        const discardOnDisk = vi.fn();
        const outOfDate = vi.fn();
        let discardDisabledReason: string | null = 'machine offline';
        let reviewed: readonly string[] = [];
        const port = createScmReviewedMarksRecordPort({ source: {
            repositoryRootPath: '/repo', source: { kind: 'workingTree' }, changeKeys: [marker.key],
        }, transport: {
            read: async () => ({ value: null, version: -1 }),
            compareAndSet: async value => { reviewed = ScmReviewedMarksRecordSchema.parse(value).reviewedChangeKeys; return { success: true, version: 0 }; },
        } });
        let review!: ReturnType<typeof useHunkReviewController>;
        let gutter!: ReturnType<typeof useEditorChangeMarkers>;
        function Review() {
            review = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'a.ts', unifiedDiff: patch,
                contentHash: 'saved-hash', host: null, serverId: null, onDiscard: discardOnDisk, discardDisabledReason, onOutOfDate: outOfDate,
                marks: { record: null, unavailableReason: null, setReviewed: () => {}, clear: () => {},
                    setReviewedKeys: (keys, kept) => { void port.setReviewedKeys(keys, kept); } } });
            gutter = useEditorChangeMarkers({ editor: engine, active: true, seedKey: 'saved-v1', markers: [marker] });
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        await act(async () => { press?.('change', { ...marker, startLine: 2, endLine: 2 }); });
        expect(gutter.selected).toMatchObject({ key: marker.key, startLine: 2 });
        expect(review.changeActionsForKey).toBeTypeOf('function');
        const actions = review.changeActionsForKey(marker.key, { discardInDraft: () => gutter.revertInDraft(gutter.selected!) })!;
        expect(actions.disabledReason('discard')).toBeNull();
        await act(async () => { actions.keep(); });
        expect(reviewed).toEqual([marker.key]);
        await act(async () => { expect(await actions.discard?.()).toEqual({ ok: true, text: 'inserted\nold\nmiddle\nafter\n' }); });
        expect(text).toBe('inserted\nold\nmiddle\nafter\n');
        expect(replaceCount).toBe(1);
        expect(discardOnDisk).not.toHaveBeenCalled();
        engine.runCommand?.('undo');
        expect(text).toBe('inserted\nnew\nmiddle\nafter\n');
        expect(review.changeActionsForKey(marker.key)?.disabledReason('discard')).toBe('machine offline');
        // A user edit inside the tracked region refuses rather than finding another occurrence or writing disk.
        text = 'inserted\nyours\nmiddle\nafter\n';
        await act(async () => { press?.('change', { ...marker, startLine: 2, endLine: 2 }); });
        const edited = review.changeActionsForKey(marker.key, { discardInDraft: () => gutter.revertInDraft(gutter.selected!) })!;
        await act(async () => { expect(await edited.discard?.()).toEqual({ ok: false, reason: 'moved_on' }); });
        expect(text).toBe('inserted\nyours\nmiddle\nafter\n');
        expect(replaceCount).toBe(1);
        expect(discardOnDisk).not.toHaveBeenCalled();
        expect(review.changeActionsForKey('stale-key')).toBeNull();
        expect(outOfDate).not.toHaveBeenCalled();
        discardDisabledReason = null;
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        await act(async () => { await review.changeActionsForKey(marker.key)?.discard?.(); });
        expect(discardOnDisk).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.ts', changeKey: marker.key, expectedHash: 'saved-hash' }));
    });
    it('shares row selection, numbering and actions across files', async () => {
        const files = [{ path: 'a.ts', unifiedDiff: patch }, { path: 'b.ts', unifiedDiff: patch }];
        let path = 'a.ts';
        let controller!: ReturnType<typeof useHunkReviewController>;
        const keep = vi.fn();
        const discard = vi.fn();
        const ask = vi.fn();
        function Review() {
            const [active, setActive] = React.useState(path);
            path = active;
            controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' },
                path: active, unifiedDiff: patch, liveFiles: files, host: null, serverId: null,
                marks: { record: null, unavailableReason: null, setReviewed: () => {}, setReviewedKeys: keep, clear: () => {} },
                onNavigate: cursor => setActive(cursor.path), onDiscard: discard, onAsk: ask });
            return null;
        }
        await renderScreen(<Review />);
        expect(controller.strip.total).toBe(4);
        expect(controller.hunksForPath('a.ts').currentIndex).toBe(0);
        expect(controller.hunksForPath('b.ts')).toMatchObject({ currentIndex: null, numberOffset: 2, numberTotal: 4 });
        await act(async () => { controller.next(); });
        await act(async () => { controller.nextFile(); });
        expect(path).toBe('b.ts');
        expect(controller.hunksForPath('a.ts').currentIndex).toBeNull();
        expect(controller.hunksForPath('b.ts').currentIndex).toBe(0);
        await act(async () => { controller.keepCurrent(); controller.discardCurrent?.(); controller.askCurrent?.(); });
        const key = buildReviewUnits('b.ts', undefined, patch)[0]!.key;
        expect(keep).toHaveBeenCalledWith([key], true);
        expect(discard).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.ts', changeKey: key }));
        expect(ask).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.ts', changeKey: key }));
    });
    it('phone review follows the reading line without moving the page, and Keep advances to the next open change', async () => {
        const three = '@@ -1,5 +1,5 @@\n-one\n+ONE\n a\n-two\n+TWO\n b\n-three\n+THREE\n';
        const keys = buildReviewUnits('a.ts', undefined, three).map(unit => unit.key);
        let kept: readonly string[] = [keys[1]!];
        let controller!: ReturnType<typeof useHunkReviewController>;
        const navigated = vi.fn();
        function Review() {
            const [record, setRecord] = React.useState<readonly string[]>(kept);
            controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'a.ts', unifiedDiff: three,
                host: null, serverId: null, onNavigate: navigated,
                marks: { record: { reviewedChangeKeys: record } as unknown as ScmReviewedMarksRecord, unavailableReason: null,
                    setReviewed: () => {}, clear: () => {},
                    setReviewedKeys: (next, on) => { kept = on ? [...record, ...next] : record.filter(key => !next.includes(key)); setRecord(kept); } } });
            return null;
        }
        await renderScreen(<Review />);
        await act(async () => { controller.hunks.onHunks?.(buildReviewUnits('a.ts', undefined, three).map((unit, index) => ({
            index, hunkIndex: unit.hunkIndex, key: unit.key, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, sectionHeading: '',
            rangeStart: index + 1, rangeEnd: index + 1, rangeSide: 'new' as const, firstChangeLineId: `line-${index}`, changeLineIds: [] }))); });
        const firstReveal = controller.revealHunk?.key;
        expect(firstReveal).toBe(keys[0]);
        // Scrolling to change 3 makes it the bar's target, without asking the page to scroll to it.
        await act(async () => { controller.followReadingLine(keys[2]!); });
        expect(controller.strip.currentOrdinal).toBe(3);
        expect(controller.currentHunk?.key).toBe(keys[2]);
        expect(controller.revealHunk).toBeNull();
        expect(navigated).not.toHaveBeenCalled();
        // Keep on the bar marks the change it targets, then glides to the next open change (2 is kept, so 1).
        await act(async () => { controller.keepCurrentAndAdvance(); });
        expect(kept).toEqual([keys[1], keys[2]]);
        expect(controller.currentHunk?.key).toBe(keys[0]);
        expect(controller.revealHunk?.key).toBe(keys[0]);
        expect(navigated).toHaveBeenLastCalledWith({ path: 'a.ts', key: keys[0] });
        // The last open change completes the file and the cursor stays.
        await act(async () => { controller.keepCurrentAndAdvance(); });
        expect(controller.strip.fileComplete).toBe(true);
        expect(controller.currentHunk?.key).toBe(keys[0]);
        // An unknown reading-line key is ignored.
        await act(async () => { controller.followReadingLine('gone'); });
        expect(controller.currentHunk?.key).toBe(keys[0]);
    });
    it('R keeps the current change offline, advances the comparison counter and rejects a stale row', async () => {
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] } });
        let unifiedDiff = patch;
        let root = '/repo';
        let value: unknown = null;
        let version = -1;
        const keys = buildReviewUnits('a.ts', undefined, patch).map(unit => unit.key);
        const port = createScmReviewedMarksRecordPort({ source: {
            repositoryRootPath: '/repo', source: { kind: 'workingTree' }, changeKeys: keys,
        }, transport: {
            read: async () => ({ value, version }),
            compareAndSet: async next => { value = next; version += 1; return { success: true, version }; },
        } });
        let controller!: ReturnType<typeof useHunkReviewController>;
        const outOfDate = vi.fn();
        function Review() {
            const [record, setRecord] = React.useState<ScmReviewedMarksRecord | null>(null);
            const setReviewedKeys = React.useCallback((selected: readonly string[], reviewed: boolean) => {
                void port.setReviewedKeys(selected, reviewed).then(result => { if (result.success) setRecord(result.record); });
            }, []);
            controller = useHunkReviewController({ source: { kind: 'live', root },
                path: 'a.ts', unifiedDiff, host: null, serverId: null, onOutOfDate: outOfDate,
                marks: { record, unavailableReason: null, setReviewed: () => {}, setReviewedKeys, clear: () => {} } });
            useReviewKeyboard(controller, { active: true });
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        expect(controller.strip).toMatchObject({ total: 2, reviewed: 0 });
        const staleKeep = controller.keepCurrent;
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true })); });
        expect(controller.strip).toMatchObject({ total: 2, reviewed: 1, fileComplete: false });
        expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
        unifiedDiff = patch.replace('+new', '+different');
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        await act(async () => { staleKeep(); });
        expect(outOfDate).toHaveBeenCalledOnce();
        expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
        unifiedDiff = patch;
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        const beforeScopeChange = controller.keepCurrent;
        root = '/other-repository';
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        await act(async () => { beforeScopeChange(); });
        expect(outOfDate).toHaveBeenCalledTimes(2);
        expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
    });
});
