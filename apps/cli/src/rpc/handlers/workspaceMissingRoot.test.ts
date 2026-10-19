import { ChildProcess, spawn } from 'child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import { runScmCommand } from '@/scm/runtime';
import type { RpcHandler } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonWorkspaceFileListResponseSchema, DaemonWorkspaceFileSearchResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm/operationError';
import { runWithBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { detectGitRepo } from '../../../../../packages/plugins/scm-git/src/repository';
import { registerWorkspaceFileListHandler } from './workspaceFileList';
import { registerWorkspaceFileSearchHandler } from './workspaceFileSearch';

vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe('missing workspace root through real process owners', () => {
    let fixture: string;
    let handlers: Map<string, RpcHandler>;
    beforeEach(async () => {
        const { spawn: nativeSpawn } = await vi.importActual<typeof import('child_process')>('child_process');
        vi.mocked(spawn).mockReset().mockImplementation(nativeSpawn);
        fixture = await mkdtemp(join(tmpdir(), 'happier-missing-root-'));
        handlers = new Map();
        const registrar = { registerHandler: (method: string, handler: RpcHandler) => { handlers.set(method, handler); } };
        registerWorkspaceFileListHandler(registrar, fixture);
        registerWorkspaceFileSearchHandler(registrar, fixture);
    });
    afterEach(async () => { vi.restoreAllMocks(); await rm(fixture, { recursive: true, force: true }); });

    it.each(['deleted', 'file', 'file-child'] as const)('reports a %s root through ripgrep, both registered RPCs and Git detection', async (kind) => {
        const root = join(fixture, 'workspace');
        await mkdir(root);
        await rm(root, { recursive: true });
        if (kind !== 'deleted') await writeFile(root, 'not a directory');
        const cwd = kind === 'file-child' ? join(root, 'child') : root;
        await expect.soft(runRipgrep(['--files'], { cwd })).rejects.toMatchObject({ code: 'WORKSPACE_ROOT_NOT_FOUND' });
        const list = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)!({ rootPath: cwd });
        const search = await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!({ rootPath: cwd, query: 'needle' });
        expect.soft(list).toEqual({ ok: false, errorCode: 'root_not_found' });
        expect.soft(search).toEqual({ ok: false, code: 'root_not_found' });
        expect.soft(DaemonWorkspaceFileListResponseSchema.safeParse(list).success).toBe(true);
        expect.soft(DaemonWorkspaceFileSearchResponseSchema.safeParse(search).success).toBe(true);
        const command = await runScmCommand({ bin: 'git', cwd, args: ['rev-parse', '--show-toplevel'] });
        expect.soft(command).toMatchObject({ success: false, workingDirectoryMissing: true });
        await runWithBackendRuntimeServices({
            runCommand: input => runScmCommand({ ...input, bin: input.command, args: [...input.args] }),
        }, async () => {
            const failure = await detectGitRepo({ cwd }).catch((error: unknown) => error);
            expect.soft(failure).toMatchObject({ errorCode: 'ROOT_NOT_FOUND' });
            expect.soft(ScmOperationErrorCodeSchema.safeParse(Reflect.get(failure as object, 'errorCode')).success).toBe(true);
        });
        if (kind === 'deleted') {
            await mkdir(root);
            await writeFile(join(root, 'found.txt'), 'needle');
            expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)!({ rootPath: root }))
                .toMatchObject({ ok: true, paths: ['found.txt'] });
        }
    });

    it('keeps a real missing launcher executable distinct from a missing cwd', async () => {
        const { spawn: nativeSpawn } = await vi.importActual<typeof import('child_process')>('child_process');
        // OS process boundary: actually attempt a nonexistent binary from a valid directory.
        vi.mocked(spawn).mockImplementation((_, args, options) => nativeSpawn(join(fixture, 'absent-runtime'), args, options));
        expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH)!({ rootPath: fixture, query: 'needle' }))
            .toEqual({ ok: false, code: 'ripgrep_unavailable' });
        expect(await handlers.get(RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST)!({ rootPath: fixture }))
            .toEqual({ ok: false, errorCode: 'ripgrep_unavailable' });
        expect(await runScmCommand({ bin: 'git', cwd: fixture, args: ['--version'] }))
            .not.toHaveProperty('workingDirectoryMissing');
    });

    it.each(['ENOENT', 'ENOTDIR', 'EINVAL'])('uses the cwd fact rather than platform-specific spawn errno %s', async (code) => {
        // OS boundary contract: Windows CreateProcess and POSIX spawn can disagree on errno.
        vi.mocked(spawn).mockImplementation(() => {
            const child = Object.assign(new ChildProcess(), {
                stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            });
            queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code })));
            // A failed spawn has no PID. Only the process streams/events are consumed here.
            return child;
        });
        const missing = join(fixture, 'absent');
        await expect(runRipgrep(['--files'], { cwd: missing })).rejects.toMatchObject({ code: 'WORKSPACE_ROOT_NOT_FOUND' });
        expect(await runScmCommand({ bin: 'git', cwd: missing, args: ['--version'] }))
            .toMatchObject({ success: false, workingDirectoryMissing: true });
        expect(await runScmCommand({ bin: 'git', cwd: fixture, args: ['--version'] }))
            .not.toHaveProperty('workingDirectoryMissing');
    });
});
