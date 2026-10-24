import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeTurnChangeSets } from '@happier-dev/protocol';

import { buildRepositoryCheckpointRefs } from './refs';
import { projectRepositoryCheckpointTurnChangeSet } from './projection';
import type { RepositoryCheckpointDiffResult } from './types';

const refs = buildRepositoryCheckpointRefs({
    scopeId: 'session-1:/repo',
    messageId: 'message-1',
    turnId: 'turn-1',
});

describe('projectRepositoryCheckpointTurnChangeSet', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([
        { root: '/home/happier/qa-fixtures/files-editor-demo', providerPath: '/home/happier/qa-fixtures/files-editor-demo/qa-f-turn/r18-notes.txt' },
        { root: '/home/happier/qa-fixtures/files-editor-demo/', providerPath: '/home/happier/qa-fixtures/files-editor-demo\\qa-f-turn\\r18-notes.txt' },
        { root: '~/qa-fixtures/files-editor-demo', providerPath: '~\\qa-fixtures\\files-editor-demo\\qa-f-turn\\r18-notes.txt' },
        { root: '~\\qa-fixtures\\files-editor-demo\\', providerPath: '~/qa-fixtures/files-editor-demo/qa-f-turn/r18-notes.txt' },
        { root: 'C:\\Users\\alice\\repo\\', providerPath: 'c:/users/alice/repo/qa-f-turn\\r18-notes.txt' },
        { root: '\\\\server\\share\\repo', providerPath: '//SERVER/share/repo/qa-f-turn/r18-notes.txt' },
        { root: '/repo', providerPath: './qa-f-turn/r18-notes.txt', checkpointPath: '.\\qa-f-turn\\r18-notes.txt' },
    ])('canonicalizes provider/checkpoint aliases before merging ($providerPath)', ({ root, providerPath, checkpointPath = 'qa-f-turn/r18-notes.txt' }) => {
        vi.stubEnv('HOME', '/home/happier/');
        vi.stubEnv('USERPROFILE', '/home/happier/');
        const result = projectRepositoryCheckpointTurnChangeSet({
            repoRootPath: root,
            scopeId: 'session-1:repo',
            providerTurnChangeSet: {
                sessionId: 'session-1', turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed', provider: 'codex', derivedAt: 1,
                files: [{ filePath: providerPath, previousFilePath: providerPath.replace('r18-notes', 'old-notes'),
                    changeKind: 'renamed', source: 'provider_native', confidence: 'strong', provider: 'codex',
                    oldText: 'before\n', newText: 'after\n' }],
            },
            checkpointDiff: {
                success: true, baseRef: refs.turnStart!, finalRef: refs.turnFinal!,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                files: [{ filePath: checkpointPath, previousFilePath: checkpointPath.replace('r18-notes', 'old-notes'),
                    changeKind: 'renamed', source: 'scm_checkpoint', confidence: 'exact', provider: 'scm:git',
                    oldText: 'before\n', newText: 'after\n' }], receipts: [],
            },
        });
        // Retain both selectable observations, but give them one identity before publication.
        expect(result.files.map(file => [file.filePath, file.previousFilePath])).toEqual([
            ['qa-f-turn/r18-notes.txt', 'qa-f-turn/old-notes.txt'],
            ['qa-f-turn/r18-notes.txt', 'qa-f-turn/old-notes.txt'],
        ]);
        const merged = mergeTurnChangeSets({ sessionId: result.sessionId, turns: [result] });
        expect(merged.files).toHaveLength(1);
        expect(merged.files[0]).toMatchObject({ filePath: 'qa-f-turn/r18-notes.txt', source: 'scm_checkpoint',
            oldText: 'before\n', newText: 'after\n', attribution: { confidence: 'session_exact' } });
    });

    it('preserves provider evidence when checkpoint diff is unavailable', () => {
        const result = projectRepositoryCheckpointTurnChangeSet({
            repoRootPath: '/repo',
            providerTurnChangeSet: {
                sessionId: 'session-1',
                turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed',
                provider: 'codex',
                derivedAt: 1,
                files: [{
                    filePath: '/repo/src/provider.ts',
                    changeKind: 'modified',
                    source: 'provider_native',
                    confidence: 'strong',
                    provider: 'codex',
                }],
            },
            checkpointDiff: {
                success: false,
                kind: 'unavailable',
                reason: 'missing_final',
                error: 'Missing final checkpoint ref.',
                baseRefSource: 'turn_start',
                contentConfidence: 'unavailable',
                attributionScope: 'unknown',
                receipts: [],
            },
            scopeId: 'session-1:/repo',
            startRef: refs.turnStart?.ref,
            finalRef: refs.turnFinal?.ref,
        });

        expect(result.files).toEqual([
            expect.objectContaining({
                filePath: 'src/provider.ts',
                source: 'provider_native',
            }),
        ]);
        expect(result.repositoryCheckpoint).toMatchObject({
            contentConfidence: 'unavailable',
            attributionScope: 'unknown',
            unavailableReason: 'missing_final',
        });
    });

    it.each([
        { root: '/home/happier', outside: '/home/happier2/notes.txt', expected: '/home/happier2/notes.txt' },
        { root: 'C:\\Users\\alice', outside: 'C:\\Users\\alice2\\notes.txt', expected: 'c:/Users/alice2/notes.txt' },
    ])('does not merge a sibling-prefix path under $root', ({ root, outside, expected }) => {
        const result = projectRepositoryCheckpointTurnChangeSet({
            repoRootPath: root, scopeId: 'session-1:repo',
            providerTurnChangeSet: {
                sessionId: 'session-1', turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed', provider: 'codex', derivedAt: 1,
                files: [{ filePath: outside, changeKind: 'modified', source: 'provider_native',
                    confidence: 'strong', provider: 'codex' }],
            },
            checkpointDiff: {
                success: true, baseRef: refs.turnStart!, finalRef: refs.turnFinal!,
                baseRefSource: 'turn_start', contentConfidence: 'exact', attributionScope: 'shared_worktree',
                files: [{ filePath: '2/notes.txt', changeKind: 'modified', source: 'scm_checkpoint',
                    confidence: 'exact', provider: 'scm:git' }], receipts: [],
            },
        });
        expect(result.files.map(file => file.filePath)).toEqual([expected, '2/notes.txt']);
        expect(mergeTurnChangeSets({ sessionId: result.sessionId, turns: [result] }).files).toHaveLength(2);
    });

    it('adds checkpoint exact evidence while keeping provider-reported evidence selectable', () => {
        const checkpointDiff: RepositoryCheckpointDiffResult = {
            success: true,
            baseRef: refs.turnStart!,
            finalRef: refs.turnFinal!,
            baseRefSource: 'turn_start',
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
            files: [{
                filePath: 'src/checkpoint.ts',
                changeKind: 'modified',
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }],
            receipts: [{ id: 'checkpoint.diff_computed', ref: refs.turnFinal!.ref }],
        };

        const result = projectRepositoryCheckpointTurnChangeSet({
            repoRootPath: '/repo',
            providerTurnChangeSet: {
                sessionId: 'session-1',
                turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed',
                provider: 'codex',
                derivedAt: 1,
                files: [{
                    filePath: 'src/provider.ts',
                    changeKind: 'modified',
                    source: 'provider_native',
                    confidence: 'strong',
                    provider: 'codex',
                }],
            },
            checkpointDiff,
            scopeId: 'session-1:/repo',
            startRef: refs.turnStart?.ref,
            finalRef: refs.turnFinal?.ref,
        });

        expect(result.files).toEqual([
            expect.objectContaining({ filePath: 'src/provider.ts', source: 'provider_native' }),
            expect.objectContaining({ filePath: 'src/checkpoint.ts', source: 'scm_checkpoint' }),
        ]);
        expect(result.repositoryCheckpoint).toMatchObject({
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
        });
    });
});
