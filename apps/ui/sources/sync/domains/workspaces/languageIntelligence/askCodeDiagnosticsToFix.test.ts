import { describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { registerComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { askCodeDiagnosticsToFix } from './askCodeDiagnosticsToFix';
import { EMPTY_CODE_DIAGNOSTICS, mergeCodeDiagnostics, selectCodeDiagnostics } from './codeDiagnostics';

describe('Ask to fix diagnostic ranges', () => {
    it('creates no partial batch when any diagnostic file no longer has saved text', async () => {
        const projection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, { status: 'ok', revision: 1,
            servers: [{ serverId: 'ts', label: 'TS', state: 'ready', loading: false, generation: 'g' }],
            diagnostics: Object.fromEntries(['a.ts', 'b.ts'].map(path => [path, { ts: {
                state: 'ready', version: 1, generation: 'g', items: [{ serverId: 'ts', path, severity: 'error', message: 'Unknown name',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }],
            } }])),
        }, { documentVersions: new Map(), serverGenerations: new Map([['ts', 'g']]) });
        const previous = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey;
        storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: {} });
        const focusComposer = vi.fn();
        const dispose = registerComposerPresentationTarget({ kind: 'session', sessionId: 'missing-holder-session' }, {
            readRevision: () => 0, replace: () => 0, focusComposer,
        });
        try {
            const result = await askCodeDiagnosticsToFix({ projection,
                workspaceScope: { serverId: 'ask-save-home', machineId: 'machine', rootPath: '/repo' },
                sessionTarget: { sessionId: 'missing-holder-session' }, isCurrent: () => true,
                readFile: async path => path === 'a.ts' ? { savedText: 'missing();', unsaved: false } : null,
                saveFileEdits: async () => false,
            });
            expect(result).toEqual({ created: 0, drafts: [] });
            expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey).toEqual({});
            expect(focusComposer).not.toHaveBeenCalled();
        } finally { dispose(); storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: previous }); }
    });

    it.each(['open', 'project'] as const)('saves %s problems before creating saved-text drafts and focuses once', async (scope) => {
        const openProjection = mergeCodeDiagnostics(EMPTY_CODE_DIAGNOSTICS, { status: 'ok', revision: 1,
            servers: [{ serverId: 'ts', label: 'TS', state: 'ready', loading: false, generation: 'g' }],
            diagnostics: { 'a.ts': { ts: { state: 'ready', version: 1, generation: 'g', items: [{
                serverId: 'ts', path: 'a.ts', severity: 'error', message: 'Unknown name',
                range: { start: { line: 0, character: 10 }, end: { line: 0, character: 16 } },
            }, {
                serverId: 'ts', path: 'a.ts', severity: 'error', message: 'Unknown name',
                range: { start: { line: 0, character: 19 }, end: { line: 0, character: 25 } },
            }] } } },
        }, { documentVersions: new Map([['a.ts', 1]]), serverGenerations: new Map([['ts', 'g']]) });
        const projection = scope === 'project' ? selectCodeDiagnostics(openProjection) : openProjection;
        const workspaceScope = { serverId: 'ask-save-home', machineId: 'machine', rootPath: '/repo' };
        const previous = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey;
        storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: {} });
        const events: string[] = [];
        const unsubscribe = storage.subscribe((state) => {
            if (Object.values(state.reviewCommentsDraftsByWorkspaceCacheKey).some((drafts) => drafts.length)) events.push('draft');
        });
        const dispose = registerComposerPresentationTarget({ kind: 'session', sessionId: 'ask-save-session' }, {
            readRevision: () => 0, replace: () => 0, focusComposer: () => { events.push('focus'); },
        });
        let saved = false;
        const readFile = vi.fn(async () => ({ savedText: saved ? 'const a = absent + absent;' : 'const a = 1;', unsaved: !saved }));
        const saveFileEdits = vi.fn(async () => { events.push('save'); saved = true; return true; });
        try {
            const result = await askCodeDiagnosticsToFix({ projection, workspaceScope, sessionTarget: { sessionId: 'ask-save-session' },
                readFile, saveFileEdits, isCurrent: () => true });
            expect(result.created).toBe(2);
            expect(result.drafts[0]).toMatchObject({ body: 'Unknown name', includeInPrompt: true,
                snapshot: { selectedLines: ['const a = absent + absent;'] } });
            expect(new Set(result.drafts.map((draft) => draft.id)).size).toBe(2);
            expect(events.indexOf('save')).toBeLessThan(events.indexOf('draft'));
            expect(events.filter((event) => event === 'focus')).toHaveLength(1);
            const again = await askCodeDiagnosticsToFix({ projection, workspaceScope, sessionTarget: { sessionId: 'ask-save-session' },
                readFile, saveFileEdits, isCurrent: () => true });
            expect(again.drafts.map((draft) => draft.id)).toEqual(result.drafts.map((draft) => draft.id));
            const noCount = await askCodeDiagnosticsToFix({ projection: EMPTY_CODE_DIAGNOSTICS, workspaceScope,
                sessionTarget: { sessionId: 'ask-save-session' }, readFile, saveFileEdits, isCurrent: () => true });
            expect(noCount.created).toBe(0);
            expect(saveFileEdits).toHaveBeenCalledOnce();
        } finally { unsubscribe(); dispose(); storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: previous }); }
    });
});
