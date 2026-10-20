import { describe, expect, it, vi } from 'vitest';
import { askAboutRanges } from './askAboutRanges';
import { storage } from '@/sync/domains/state/storage';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { registerComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';

describe('Ask ranges batch destination', () => {
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
