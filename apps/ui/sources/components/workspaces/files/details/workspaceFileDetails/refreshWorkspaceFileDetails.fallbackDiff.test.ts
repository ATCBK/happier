import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cleanupWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';

const machineScmDiffFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    diff: '',
}));

const workspaceStatFileSpy = vi.fn(async (..._args: any[]) => ({
    success: true,
    exists: true,
    kind: 'file',
    sizeBytes: 1024,
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmDiffFile: (...args: any[]) => machineScmDiffFileSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    callDaemonWorkspaceStatFileRpc: (...args: any[]) => workspaceStatFileSpy(...args),
}));

vi.mock('@/config', () => ({
    config: { filesPreviewMaxBytes: 1024 * 1024 },
}));

installWorkspaceFileDetailsCommonModuleMocks();
installWorkspaceFileDetailsActionBoundary();
const workspaceFileDetailsActionBoundary = getWorkspaceFileDetailsActionBoundary();

describe('refreshWorkspaceFileDetails (fallback diff)', () => {
    let serverId: string;
    beforeEach(async () => {
        serverId = await prepareWorkspaceFileDetailsActionBoundary();
        workspaceFileDetailsActionBoundary.read.mockReset().mockResolvedValue({
            success: true,
            content: Buffer.from('hello\nworld\n').toString('base64'),
        });
    });
    afterEach(async () => {
        vi.useRealTimers();
        await cleanupWorkspaceFileDetailsActionBoundary();
    });

    it('returns a synthesized diff for untracked/added files when backend returns empty diff', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceFileDetailsActionBoundary.read.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId, machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/new.txt',
            diffMode: 'pending',
            fileEntryKind: 'untracked',
        });

        expect(result.status).toBe('ready');
        expect(result.error).toBeNull();
        expect(result.diffContent).toContain('diff --git a/src/new.txt b/src/new.txt');
        expect(result.diffContent).toContain('+hello');
        expect(result.diffContent).toContain('+world');
        expect(machineScmDiffFileSpy).toHaveBeenCalledWith(
            'm1',
            {
                cwd: '/repo',
                path: 'src/new.txt',
                area: 'pending',
            },
            { serverId },
        );
    });

    it('returns the sha256 hash for editable text content', async () => {
        machineScmDiffFileSpy.mockClear();
        workspaceFileDetailsActionBoundary.read.mockClear();

        const { refreshWorkspaceFileDetails } = await import('./refreshWorkspaceFileDetails');
        const result = await refreshWorkspaceFileDetails({
            scope: { serverId, machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/a.txt',
            diffMode: 'pending',
            fileEntryKind: 'modified',
        });

        expect(result.status).toBe('ready');
        expect(result.fileContent?.contentHash).toBe(createHash('sha256').update('hello\nworld\n').digest('hex'));
    });
});
