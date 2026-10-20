import { describe, expect, it } from 'vitest';
import { resolveReviewCommentFileOpen } from './reviewCommentFileTarget';

describe('review comment file targets', () => {
    it('opens the qualified session in Changes at the reviewed range', () => {
        const anchor = { kind: 'range' as const, filePath: 'src/a.ts', startLine: 4, endLine: 8, side: 'after' as const };
        expect(resolveReviewCommentFileOpen({ anchor }, { sessionId: 'session-a', serverId: 'home-a' })).toEqual({
            target: { kind: 'session', sessionId: 'session-a', serverId: 'home-a', path: anchor.filePath },
            options: { view: 'changes', anchor, anchorSource: 'diff' },
        });
    });
    it('opens a project file only with its exact checkout and confines absolute paths to that checkout', () => {
        const context = { workspaceRefId: 'checkout-a', serverId: 'home-a', workspace: { machineId: 'machine-a', path: 'C:\\Repo' } };
        expect(resolveReviewCommentFileOpen({ anchor: { kind: 'file', filePath: 'C:\\Repo\\src\\a.ts' } }, context)?.target)
            .toEqual({ kind: 'project', workspaceRefId: 'checkout-a', serverId: 'home-a', machineId: 'machine-a', rootPath: 'C:\\Repo', path: 'src/a.ts' });
        expect(resolveReviewCommentFileOpen({ anchor: { kind: 'file', filePath: 'C:\\Repo-other\\a.ts' } }, context)).toBeNull();
        expect(resolveReviewCommentFileOpen({ anchor: { kind: 'file', filePath: 'a.ts' } }, { serverId: 'home-a' })).toBeNull();
        expect(resolveReviewCommentFileOpen({ anchor: { kind: 'folder', folderPath: 'src' } }, context)).toBeNull();
    });
});
