import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useChangedFilesReviewDiffLoading } from './useChangedFilesReviewDiffLoading';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from './filesContentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFilesContentCommonModuleMocks();

const machineScmDiffFileSpy = vi.fn(async () => ({ success: true, diff: '', error: null }));
const workspaceReadFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    content: Buffer.from('hello\nworld\n').toString('base64'),
    error: null,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: () => machineScmDiffFileSpy(),
}));

vi.mock('@/sync/domains/session/resolveWorkspaceTargetForSession', () => ({
    resolveWorkspaceTargetForSession: () => ({
        workspaceCacheKey: 'server:m1:/repo',
        machineId: 'm1',
        rootPath: '/repo',
        serverId: 'server',
    }),
}));

vi.mock('@/sync/ops/workspaceFileSystem/fileReadWrite', () => ({
    workspaceReadFile: (...args: any[]) => workspaceReadFileSpy(...args),
}));

describe('useChangedFilesReviewDiffLoading (fallback diff)', () => {
    it('synthesizes a diff for untracked files when SCM diff returns empty', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceReadFileSpy.mockClear();

        const file = {
            fileName: 'new.txt',
            filePath: 'src',
            fullPath: 'src/new.txt',
            status: 'untracked',
            isIncluded: false,
            linesAdded: 0,
            linesRemoved: 0,
        } as any;

        let diffStateSource: any = null;

        function Probe() {
            const reviewFiles = React.useMemo(() => [file], []);
            const normalizeError = React.useCallback((e: unknown) => String((e as any)?.message ?? e), []);
            const hook = useChangedFilesReviewDiffLoading({
                sessionId: 's1',
                isRepo: true,
                reviewFiles,
                diffArea: 'pending',
                tooLarge: false,
                selectedPath: 'src/new.txt',
                minRefetchMs: 0,
                refreshToken: 0,
                normalizeError,
                fallbackError: 'fallback',
            });
            diffStateSource = hook.diffStateSource;
            return React.createElement('Probe');
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            // The canonical workspace fallback lazily imports its file reader.
            await vi.dynamicImportSettled();
        });

        expect(machineScmDiffFileSpy).toHaveBeenCalledTimes(1);
        expect(workspaceReadFileSpy).toHaveBeenCalledTimes(1);
        const finalState = diffStateSource?.getDiffState?.('src/new.txt');
        expect(String(finalState?.diff ?? '')).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(String(finalState?.diff ?? '')).toContain('+hello');
        expect(String(finalState?.diff ?? '')).toContain('+world');
    });
});
