import { describe, expect, it } from 'vitest';

import { buildUniversalSearchWorkspaceFileResults } from './workspaceFileSearchResults';

describe('buildUniversalSearchWorkspaceFileResults', () => {
    it('maps only actual files to openable Universal Search results', () => {
        const scope = { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' } as const;

        const results = buildUniversalSearchWorkspaceFileResults({
            files: [
                { fileName: 'src/', filePath: '', fullPath: 'src/', fileType: 'folder' },
                { fileName: 'index.ts', filePath: 'src/', fullPath: 'src/index.ts', fileType: 'file' },
            ],
            accountId: 'account-a',
            scope,
            workspaceRefId: null,
            sessionId: 'session-a',
        });

        expect(results).toEqual([expect.objectContaining({
            id: 'src/index.ts',
            title: 'index.ts',
            target: expect.objectContaining({
                kind: 'workspaceFile',
                path: 'src/index.ts',
            }),
        })]);
    });

    it('captures a saved workspace activation target without fabricating a Session', () => {
        const results = buildUniversalSearchWorkspaceFileResults({
            files: [{ fileName: 'README.md', filePath: '', fullPath: 'README.md', fileType: 'file' }],
            accountId: 'account-a',
            scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' },
            workspaceRefId: 'workspace-a',
            sessionId: null,
        });

        expect(results[0]?.target).toMatchObject({
            kind: 'workspaceFile',
            workspaceRefId: 'workspace-a',
            sessionId: null,
        });
    });

    it('names every row\'s folder (the root by its name, no trailing slash) and carries a changed file\'s lines', () => {
        const results = buildUniversalSearchWorkspaceFileResults({
            files: [
                { fileName: 'README.md', filePath: '', fullPath: 'README.md', fileType: 'file' },
                { fileName: 'retry.ts', filePath: 'src/', fullPath: 'src/retry.ts', fileType: 'file' },
            ],
            accountId: 'account-a',
            scope: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/home/me/happier' },
            workspaceRefId: null,
            sessionId: null,
            changes: new Map([['src/retry.ts', { added: 4, removed: 2 }]]),
        });

        expect(results.map(result => [result.subtitle, result.fileChange ?? null])).toEqual([
            ['happier', null],
            ['src', { added: 4, removed: 2 }],
        ]);
    });
});
