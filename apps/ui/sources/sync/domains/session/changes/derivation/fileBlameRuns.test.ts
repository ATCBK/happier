import { describe, expect, it } from 'vitest';
import { deriveFileBlameRuns, type FileBlameTurn } from './fileBlameRuns';

describe('deriveFileBlameRuns', () => {
    it('merges consecutive ranges for one commit and separates committed, session and unknown lines', () => {
        const commit = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', authorName: 'Alex', authoredAtMs: 10, summary: 'Original' };
        const presentation: FileBlameTurn = {
            turnId: 'turn-1', sessionId: 'session-1', label: 'Turn 1', agentLabel: 'Agent',
            sessionTitle: 'Fix', writtenAtMs: 20, requester: null,
        };
        const runs = deriveFileBlameRuns({
            text: 'original\nmore\none\ntwo\nhuman\n', nowMs: 30, uncommittedLabel: 'Uncommitted',
            response: { success: true, commits: [commit], ranges: [
                { startLine: 1, lineCount: 1, commitIndex: 0 },
                { startLine: 2, lineCount: 1, commitIndex: 0 },
                { startLine: 3, lineCount: 3, commitIndex: null },
            ] },
            turns: [{ turnId: 'turn-1', label: 'Turn 1', order: 0, presentation,
                evidence: { filePath: 'a', changeKind: 'modified', source: 'provider_native', confidence: 'exact', provider: 'agent',
                    unifiedDiff: '@@ -3,2 +3,2 @@\n-old\n-old\n+one\n+two\n' } }],
        });
        expect(runs).toMatchObject([
            { kind: 'commit', startLine: 1, lineCount: 2, label: 'Alex', ageMs: 20, commit },
            { kind: 'session', startLine: 3, lineCount: 2, label: 'Agent · Turn 1', ageMs: 10, turn: presentation },
            { kind: 'uncommitted', startLine: 5, lineCount: 1, label: 'Uncommitted' },
        ]);
    });

    it('keeps git-committed lines committed even when a turn has matching added text', () => {
        const presentation: FileBlameTurn = {
            turnId: 't', sessionId: 's', label: 'Turn 1', agentLabel: 'Agent', sessionTitle: 'Fix', writtenAtMs: 20, requester: null,
        };
        const commit = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', authorName: 'Alex', authoredAtMs: 10, summary: 'Original' };
        const runs = deriveFileBlameRuns({ text: 'one\n', nowMs: 30, uncommittedLabel: 'Uncommitted',
            response: { success: true, commits: [commit], ranges: [{ startLine: 1, lineCount: 1, commitIndex: 0 }] },
            turns: [{ turnId: 't', label: 'Turn 1', order: 0, presentation, evidence: {
                filePath: 'a', changeKind: 'added', source: 'provider_native', confidence: 'exact', provider: 'agent', unifiedDiff: '@@ -0,0 +1 @@\n+one\n',
            } }],
        });
        expect(runs).toMatchObject([{ kind: 'commit', commit }]);
    });

    it('returns no phantom line for an empty file', () => {
        expect(deriveFileBlameRuns({ response: { success: true, commits: [], ranges: [] }, text: '', turns: [], uncommittedLabel: 'Uncommitted', nowMs: 0 }))
            .toEqual([]);
    });
});
