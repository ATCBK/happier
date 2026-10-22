import * as React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import { createChangedFilesReviewFind } from './useChangedFilesReviewFind';
import { fetchWorkspaceUnifiedDiffForPath } from '@/scm/diff/fetchWorkspaceUnifiedDiffForPath';
import { ScmComparisonFileSchema } from '@happier-dev/protocol/scm';

const scm = vi.hoisted(() => ({ read: vi.fn(), diff: vi.fn() }));
// The exact-Machine SCM transport is external; revision validation, loader,
// parser and Find all remain real beneath it.
vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmFileRead: (...args: unknown[]) => scm.read(...args),
    machineScmDiffFile: (...args: unknown[]) => scm.diff(...args),
}));
await import('@/scm/files/fetchWorkspaceFileAtRevision');
afterEach(() => { standardCleanup(); vi.clearAllMocks(); });

const baseText = Array.from({ length: 30 }, (_, i) => `coast ${i === 15 ? 'hidden cedar' : i}`).join('\n') + '\n';
const diff = '@@ -2,3 +2,3 @@\n coast 1\n-coast 2\n+changed 2\n coast 3\n@@ -27,3 +27,3 @@\n coast 26\n-coast 27\n+changed 27\n coast 28\n';
const files: ScmFileStatus[] = [{ fullPath: 'coast.ts', fileName: 'coast.ts', filePath: '', status: 'modified',
    isIncluded: false, linesAdded: 2, linesRemoved: 2 }];
const workspaceScope = { serverId: 'home-a', machineId: 'machine-a', rootPath: '/coast' };
const fetchDiff: NonNullable<Parameters<typeof useChangedFilesReviewDiffLoading>[0]['fetchUnifiedDiffForPath']> =
    input => fetchWorkspaceUnifiedDiffForPath({ ...input, scope: workspaceScope });
const capturedFile = ScmComparisonFileSchema.parse({ path: 'coast.ts', previousPath: 'old-coast.ts', changeKind: 'renamed',
    beforeBlobId: 'fixed-before-blob', binary: false, generated: false, lockfile: false,
    evidence: { state: 'available', unifiedDiff: diff }, occurrences: [] });
const capturedDiffs = new Map([['coast.ts', diff]]);

describe('review Find context loading', () => {
    it.each(['workspace', 'captured'] as const)('reads the %s revision on Find demand through the real loader and matcher', async (kind) => {
        scm.diff.mockResolvedValue({ success: true, diff });
        const reading = createDeferred<unknown>();
        scm.read.mockReturnValue(reading.promise);
        let open = false;
        const hook = await renderHook(() => {
            const loading = useChangedFilesReviewDiffLoading({ sessionId: '', isRepo: true, reviewFiles: files,
                diffArea: 'pending', selectedPath: 'coast.ts', tooLarge: false, normalizeError: String, fallbackError: 'unavailable',
                fetchUnifiedDiffForPath: fetchDiff,
                workspaceScope, findContext: open,
                ...(kind === 'captured' ? { comparisonFiles: [capturedFile], providerDiffByPath: capturedDiffs } : {}) });
            const [find] = React.useState(createChangedFilesReviewFind);
            React.useEffect(() => find.connect({ paths: ['coast.ts'], diffStateSource: loading.diffStateSource, reveal() {} }), [find, loading.diffStateSource]);
            return { ...loading, find };
        });
        await flushHookEffects();
        expect(scm.read).not.toHaveBeenCalled();
        open = true;
        await hook.rerender();
        await act(() => { hook.getCurrent().find.open(); hook.getCurrent().find.setQuery('hidden cedar'); });
        await flushHookEffects();
        expect(hook.getCurrent().find.status).toMatchObject({ kind: 'searching' });
        const bytes = Buffer.from(baseText);
        await act(async () => reading.resolve({ success: true, contentBase64: bytes.toString('base64'), sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(hook.getCurrent().find.status).toMatchObject({ kind: 'results', current: 1, total: 1, coverage: 'complete' });
        });
        expect(scm.read).toHaveBeenCalledWith('machine-a', expect.objectContaining({ cwd: '/coast',
            path: kind === 'captured' ? 'old-coast.ts' : 'coast.ts',
            selector: kind === 'captured' ? { blobId: 'fixed-before-blob' } : { side: 'before', area: 'pending' } }),
            expect.objectContaining({ serverId: 'home-a' }));
        open = false;
        await hook.rerender();
        expect(hook.getCurrent().diffStateSource.getDiffState('coast.ts')).not.toHaveProperty('context');
    });

    it('retires an unfinished revision read when Find closes', async () => {
        scm.diff.mockResolvedValue({ success: true, diff });
        const reading = createDeferred<unknown>();
        scm.read.mockReturnValue(reading.promise);
        let open = true;
        const hook = await renderHook(() => useChangedFilesReviewDiffLoading({ sessionId: '', isRepo: true, reviewFiles: files,
            diffArea: 'pending', selectedPath: 'coast.ts', tooLarge: false, normalizeError: String, fallbackError: 'unavailable',
            fetchUnifiedDiffForPath: fetchDiff, workspaceScope, findContext: open }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(scm.read).toHaveBeenCalled();
        });
        const signal = scm.read.mock.lastCall?.[2].signal as AbortSignal;
        open = false;
        await hook.rerender();
        expect(signal.aborted).toBe(true);
        await act(async () => { reading.resolve({ success: false, errorCode: 'blob_unavailable' }); });
        await flushHookEffects();
        expect(hook.getCurrent().diffStateSource.getDiffState('coast.ts')).not.toHaveProperty('context');
    });
});
