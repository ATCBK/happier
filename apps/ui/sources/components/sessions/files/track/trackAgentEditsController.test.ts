import { describe, expect, it, vi } from 'vitest';

import { resolveDetailsTabOpenAs, type LastPreviewOpen } from '@/components/appShell/panes/hooks/resolveDetailsTabOpenAs';
import { createToolCallMessageFixture } from '@/dev/testkit';
import { deriveLiveFileWrites } from '@/sync/domains/session/changes/derivation/deriveLiveFileWrites';
import { createTrackAgentEditsController, type TrackAgentEditsInput, type TrackPauseReason, type TrackRegion, type TrackWrite } from './trackAgentEditsController';

function write(startedAt: number, region: TrackRegion = { startLine: 14, endLine: 16 }, sessionId = 'session'): TrackWrite & Readonly<{ kind: 'modify' }> {
    return { toolCallId: `tool-${startedAt}`, kind: 'modify', startedAt, sessionId, region };
}

function setup() {
    const openPreview = vi.fn();
    const revealRegion = vi.fn();
    const controller = createTrackAgentEditsController({ openPreview, revealRegion, reducedMotion: () => false });
    let input: TrackAgentEditsInput = {
        enabled: true, sessionActive: true, sessionId: 'session', writes: new Map([['a.ts', write(1)]]), activePath: null, dirtyPaths: new Set(),
    };
    const update = (patch: Partial<TrackAgentEditsInput> = {}) => { input = { ...input, ...patch }; controller.update(input); };
    return { controller, update, openPreview, revealRegion };
}

describe('Track agent edits controller', () => {
    it('consumes P3’s real projection without allowing a nested subagent write to move Track', () => {
        const main = createToolCallMessageFixture({ tool: { name: 'Write', input: { file_path: 'main.ts', content: 'main' },
            state: 'running', id: 'main-write', createdAt: 1, startedAt: 1, completedAt: null, description: null } });
        const child = createToolCallMessageFixture({ tool: { name: 'Write', input: { file_path: 'child.ts', content: 'child' },
            state: 'running', id: 'child-write', createdAt: 2, startedAt: 2, completedAt: null, description: null } });
        const task = createToolCallMessageFixture({ tool: { name: 'Task', input: {}, state: 'running', id: 'task',
            createdAt: 1, startedAt: 1, completedAt: null, description: null }, children: [child] });
        const writes = deriveLiveFileWrites([main, task], { workspaceRoot: '/repo', sessionId: 'session' });
        const { controller, update, openPreview } = setup();
        update({ writes });
        expect(controller.getSnapshot().target?.path).toBe('main.ts');
        expect(openPreview.mock.calls.map(([target]) => target.path)).toEqual(['main.ts']);
    });
    it('follows the latest main-session path once and reveals region changes without reopening or pinning the preview', () => {
        const { controller, update, openPreview, revealRegion } = setup();
        update();
        expect(controller.getSnapshot()).toMatchObject({ enabled: true, paused: false, target: { path: 'a.ts' } });
        const first = openPreview.mock.calls[0]?.[0];
        expect(first).toMatchObject({ path: 'a.ts', region: { startLine: 14 } });
        update({ activePath: 'a.ts', writes: new Map([['a.ts', write(2, { startLine: 20, endLine: 21 })]]) });
        expect(openPreview).toHaveBeenCalledTimes(1);
        expect(revealRegion.mock.calls.at(-1)?.[0]).toMatchObject({ path: 'a.ts', region: { startLine: 20 } });
        update({ writes: new Map([['a.ts', write(2)], ['b.ts', write(3)]]) });
        expect(openPreview.mock.calls.map(([target]) => target.path)).toEqual(['a.ts', 'b.ts']);
        // Feeding only path changes to the actual pane policy cannot trigger its double-open pin rule.
        let last: LastPreviewOpen | null = null;
        for (const [i, [target]] of openPreview.mock.calls.entries()) {
            const decision = resolveDetailsTabOpenAs({ detailsPaneTabsBehavior: 'preview', intent: 'preview', platform: 'web',
                nowMs: i * 10, tabKey: `file:${target.path}`, existingTab: { isPreview: true }, lastPreviewOpen: last });
            expect(decision.openAs).toBe('preview');
            last = decision.nextLastPreviewOpen;
        }
    });

    it('reveals an Edit placed only by the text it replaces, and again when that text changes', () => {
        const { update, revealRegion } = setup();
        const edit = (startedAt: number, anchorText: string): TrackWrite => ({ toolCallId: `e${startedAt}`, sessionId: 'session', startedAt, anchorText });
        update({ writes: new Map([['a.ts', edit(1, 'return key;')]]) });
        expect(revealRegion.mock.calls.at(-1)?.[0]).toMatchObject({ path: 'a.ts', write: { anchorText: 'return key;' } });
        update({ activePath: 'a.ts', writes: new Map([['a.ts', edit(2, 'const width = 1;')]]) });
        expect(revealRegion).toHaveBeenCalledTimes(2);
        expect(revealRegion.mock.calls.at(-1)?.[0]).toMatchObject({ write: { anchorText: 'const width = 1;' } });
    });

    it.each<TrackPauseReason>(['scroll', 'touch', 'selection', 'typing', 'tabActivation'])('pauses immediately for %s and Resume returns to the current region', (reason) => {
        const { controller, update, openPreview, revealRegion } = setup();
        update();
        controller.pause(reason);
        expect(controller.getSnapshot()).toMatchObject({ paused: true, pauseReason: reason });
        update({ activePath: 'a.ts', writes: new Map([['b.ts', write(2, { startLine: 30, endLine: 30 })]]) });
        expect(openPreview).toHaveBeenCalledTimes(1);
        expect(revealRegion).toHaveBeenCalledTimes(1);
        controller.resume();
        expect(controller.getSnapshot().paused).toBe(false);
        expect(openPreview.mock.calls.at(-1)?.[0]).toMatchObject({ path: 'b.ts' });
        expect(revealRegion.mock.calls.at(-1)?.[0]).toMatchObject({ region: { startLine: 30 } });
    });

    it('ignores activation/selection from its own programmatic moves', () => {
        const { controller, update, openPreview } = setup();
        update();
        controller.pause('tabActivation', openPreview.mock.calls[0]?.[1]);
        expect(controller.getSnapshot().paused).toBe(false);
        controller.pause('tabActivation', Symbol('unrelated'));
        expect(controller.getSnapshot().paused).toBe(true);
    });

    it.each(['active', 'target', 'preview'])('protects the %s dirty editor even on Resume', (dirty) => {
        const { controller, update, openPreview, revealRegion } = setup();
        update({ activePath: 'mine.ts', previewPath: 'preview.ts', dirtyPaths: new Set([dirty === 'active' ? 'mine.ts' : dirty === 'target' ? 'a.ts' : 'preview.ts']) });
        controller.resume();
        expect(controller.getSnapshot()).toMatchObject({ paused: true, pauseReason: 'dirtyEditor' });
        expect(openPreview).not.toHaveBeenCalled();
        expect(revealRegion).not.toHaveBeenCalled();
        update({ dirtyPaths: new Set() });
        expect(openPreview).not.toHaveBeenCalled();
        controller.resume();
        expect(openPreview.mock.calls[0]?.[0]).toMatchObject({ path: 'a.ts' });
    });

    it('clears presence on lifecycle end and pause on disable/session replacement, and ignores foreign writes', () => {
        const { controller, update, openPreview } = setup();
        update({ writes: new Map([['other.ts', write(2, undefined, 'subagent')]]) });
        expect(controller.getSnapshot().target).toBeNull();
        expect(openPreview).not.toHaveBeenCalled();
        update();
        controller.pause('scroll');
        update({ writes: new Map(), sessionActive: false });
        expect(controller.getSnapshot()).toMatchObject({ paused: false, target: null });
        update({ writes: new Map([['a.ts', write(3)]]), enabled: false });
        expect(controller.getSnapshot()).toMatchObject({ enabled: false, paused: false, target: null });
        update({ enabled: true, sessionActive: true });
        controller.pause('typing');
        update({ sessionId: 'next', writes: new Map([['next.ts', write(4, undefined, 'next')]]) });
        expect(controller.getSnapshot()).toMatchObject({ paused: false, target: { path: 'next.ts' } });
    });

    it('ignores a smaller column on the same row and honors reduced motion on Resume', () => {
        const openPreview = vi.fn();
        const revealRegion = vi.fn();
        const controller = createTrackAgentEditsController({ openPreview, revealRegion, reducedMotion: () => true });
        const input = { enabled: true, sessionActive: true, sessionId: 'session', activePath: null as string | null, dirtyPaths: new Set<string>() };
        controller.update({ ...input, writes: new Map([['a.ts', write(1, { startLine: 12, endLine: 12, column: 18 })]]) });
        controller.update({ ...input, activePath: 'a.ts', writes: new Map([['a.ts', write(2, { startLine: 12, endLine: 12, column: 4 })]]) });
        expect(controller.getSnapshot().target?.region?.column).toBe(18);
        controller.pause('scroll');
        controller.resume();
        expect(revealRegion.mock.calls.at(-1)?.[1]).toBe('instant');
        expect(openPreview).toHaveBeenCalledTimes(1);
    });

    it('retains a person’s pause between writes in an active turn and clears it when that lifecycle ends', () => {
        const { controller, update, openPreview } = setup();
        update();
        controller.pause('scroll');
        update({ writes: new Map() });
        expect(controller.getSnapshot()).toMatchObject({ paused: true, target: null });
        update({ writes: new Map([['b.ts', write(2)]]) });
        expect(openPreview).toHaveBeenCalledTimes(1);
        update({ sessionActive: false });
        expect(controller.getSnapshot()).toMatchObject({ paused: false, target: null });
    });

    it('exposes the live target for Watch while Track is off by default without opening or revealing it', () => {
        const { controller, update, openPreview, revealRegion } = setup();
        update({ enabled: false });
        expect(controller.getSnapshot()).toMatchObject({ enabled: false, paused: false, target: { path: 'a.ts' } });
        expect(openPreview).not.toHaveBeenCalled();
        expect(revealRegion).not.toHaveBeenCalled();
    });
});
