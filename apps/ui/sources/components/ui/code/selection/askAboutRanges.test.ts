import { describe, expect, it, vi } from 'vitest';
import { askAboutRanges } from './askAboutRanges';
import { storage } from '@/sync/domains/state/storage';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { registerComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { askSelectionQuote } from './askSelectionTarget';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';

describe('Ask ranges batch destination', () => {
    it('opens a session side-run draft without detaching it from the incumbent session', async () => {
        const opened: DetailsTab[] = [];
        const workspaceScope = { serverId: 'ask-side-run-home', machineId: 'machine', rootPath: '/repo' };
        const result = await askSelectionQuote({
            workspaceScope,
            sessionTarget: { sessionId: 'incumbent-session' },
            quote: 'Explain src/app.ts:4\n```ts\nreturn answer;\n```',
            sideRun: true,
            context: {
                accountLifetime: {
                    scope: { serverId: workspaceScope.serverId, accountId: 'account' },
                    isCurrent: () => true,
                    onRetire: () => ({ dispose() {} }),
                },
                withoutSessionTarget: 'detached_run',
                openDetailsTab: tab => { opened.push(tab); },
                navigateToNewSession: () => { throw new Error('Existing session must retain its side run'); },
                onDetachedUnavailable: () => { throw new Error('Session runs do not require detached support'); },
            },
        });
        expect(result).toBe(true);
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ kind: 'executionRunLauncher', resource: {
            mode: 'conversation', initialInstructions: 'Explain src/app.ts:4\n```ts\nreturn answer;\n```',
        } });
        // The run renderer inherits the incumbent session unless the launcher explicitly detaches it.
        expect(opened[0]?.resource).not.toHaveProperty('sessionId');
        expect(opened[0]?.resource).not.toHaveProperty('workspace');
    });

    it('creates distinct cross-file drafts and focuses one incumbent composer once', async () => {
        const workspaceScope = { serverId: 'ask-batch-home', machineId: 'machine', rootPath: '/repo' };
        const previous = storage.getState().reviewCommentsDraftsByWorkspaceCacheKey;
        const focus = vi.fn();
        const reveal = vi.fn();
        const dispose = registerComposerPresentationTarget({ kind: 'session', sessionId: 'ask-batch-session' }, {
            readRevision: () => 0, replace: () => 0, focusComposer: focus,
        });
        storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: {} });
        const first = { filePath: 'a.ts', savedText: 'const a = absent;', ranges: [
            { startLine: 1, endLine: 1, body: 'Unknown name' }, { startLine: 1, endLine: 1, body: 'Unused binding' },
        ] };
        // Supplying the first group too makes the predecessor's ignored batch fail on the observable draft count.
        const input = { workspaceScope, ...first, files: [first, { filePath: 'b.ts', savedText: 'const b = absent;',
            ranges: [{ startLine: 1, endLine: 1, body: 'Missing import' }] }],
            sessionTarget: { sessionId: 'ask-batch-session', revealSessionColumn: reveal } };
        try {
            const result = await askAboutRanges(input);
            expect(result.created).toBe(3);
            expect(result.drafts.map((draft) => [draft.filePath, draft.body, draft.includeInPrompt])).toEqual([
                ['a.ts', 'Unknown name', true], ['a.ts', 'Unused binding', true], ['b.ts', 'Missing import', true],
            ]);
            expect(storage.getState().reviewCommentsDraftsByWorkspaceCacheKey[buildWorkspaceCacheKey(workspaceScope)]).toHaveLength(3);
            expect(reveal).toHaveBeenCalledOnce();
            expect(focus).toHaveBeenCalledOnce();
        } finally {
            dispose();
            storage.setState({ reviewCommentsDraftsByWorkspaceCacheKey: previous });
        }
    });
});
