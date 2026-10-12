import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { classifySpawnFailure } from './classifySpawnFailure';

const failure = (code: string, syscall?: string) => Object.assign(new Error('private executable path'), { code, ...(syscall ? { syscall } : {}) });

describe('spawn failure classification', () => {
    it.skipIf(process.platform === 'win32')('classifies a real failed spawn in a child with its own lowered file limit', async () => {
        const fixture = fileURLToPath(new URL('./spawnFailure.fixture.mjs', import.meta.url));
        const { stdout } = await promisify(execFile)('/bin/sh', ['-c', 'ulimit -n 64; exec "$1" --experimental-strip-types "$2"', 'spawn-failure-fixture', process.execPath, fixture]);
        expect(JSON.parse(stdout)).toMatchObject({ spawnFailure: { reason: 'too_many_open_files', errno: 'EMFILE' }, message: expect.stringContaining("can't open more files") });
    });
    it.each(['EMFILE', 'ENFILE'])('reports exhausted file descriptors from %s', (errno) => {
        expect(classifySpawnFailure(failure(errno))).toEqual({ reason: 'too_many_open_files', errno });
    });
    it('only interprets Darwin posix_spawn EBADF with measured exhausted descriptors', () => {
        const error = failure('EBADF', 'posix_spawn');
        expect(classifySpawnFailure(error, { platform: 'darwin', limits: { daemonFiles: { used: 256, max: 256 } } })).toEqual({ reason: 'too_many_open_files', errno: 'EBADF' });
        for (const context of [{ platform: 'darwin' as const }, { platform: 'darwin' as const, limits: { daemonFiles: { used: 255, max: 256 } } }, { platform: 'linux' as const, limits: { daemonFiles: { used: 256, max: 256 } } }]) {
            expect(classifySpawnFailure(error, context).reason).toBe('other');
        }
        expect(classifySpawnFailure(failure('EBADF', 'read'), { platform: 'darwin', limits: { daemonFiles: { used: 256, max: 256 } } }).reason).toBe('other');
    });
    it.each(['openpty', 'forkpty'] as const)('distinguishes %s exhaustion from ambiguous process creation', (syscall) => {
        for (const errno of ['ENXIO', 'EAGAIN']) expect(classifySpawnFailure(failure(errno, syscall))).toEqual({ reason: 'no_ptys', errno });
        expect(classifySpawnFailure(failure('ENXIO', 'spawn')).reason).toBe('other');
    });
    it('requires measured exhaustion before blaming process limits for EAGAIN', () => {
        for (const syscall of ['fork', 'spawn']) {
            const error = failure('EAGAIN', syscall);
            expect(classifySpawnFailure(error, { limits: { processes: { used: 16, max: 16 } } })).toEqual({ reason: 'process_limit', errno: 'EAGAIN' });
            expect(classifySpawnFailure(error).reason).toBe('other');
            expect(classifySpawnFailure(error, { limits: { processes: { used: 15, max: 16 } } }).reason).toBe('other');
            expect(classifySpawnFailure(error, { limits: { processes: { used: NaN, max: 0 } } }).reason).toBe('other');
        }
        expect(classifySpawnFailure(failure('EAGAIN', 'read'), { limits: { processes: { used: 16, max: 16 } } }).reason).toBe('other');
    });
    it('recognizes memory exhaustion and preserves unknown errno without private diagnostics', () => {
        expect(classifySpawnFailure(failure('ENOMEM'))).toEqual({ reason: 'out_of_memory', errno: 'ENOMEM' });
        expect(classifySpawnFailure(failure('EACCES'))).toEqual({ reason: 'other', errno: 'EACCES' });
        expect(classifySpawnFailure(new Error('private executable path'))).toEqual({ reason: 'other' });
    });
});
