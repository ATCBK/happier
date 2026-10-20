import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScmBlameFileResponseSchema, createScmCapabilitiesFromBackendCapabilities } from '@happier-dev/protocol/scm';
import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { GIT_SCM_BACKEND_CAPABILITIES } from '../capabilities.js';
import * as reads from './readOperations.js';

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let root: string;
const context = () => ({ cwd: root, projectKey: root, detection: { isRepo: true, rootPath: root, mode: '.git' as const } });
async function blame(path: string, expectedHash?: string) {
    expect(reads.gitBlameFile, 'Git must contribute working-tree blame').toBeTypeOf('function');
    const response = await runWithRealGitScmRuntime(() => reads.gitBlameFile({ context: context(), request: { cwd: root, path, ...(expectedHash ? { expectedHash } : {}) } }));
    return ScmBlameFileResponseSchema.parse(response);
}
async function commit(author: string, subject: string) {
    git(root, ['add', '.']);
    git(root, ['-c', `user.name=${author}`, '-c', `user.email=${author.toLowerCase()}@example.test`, 'commit', '-m', subject]);
    return git(root, ['rev-parse', 'HEAD']);
}
describe('Git working-tree blame', () => {
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'happier-blame-'));
        git(root, ['init']);
        git(root, ['config', 'user.name', 'Blame Author']);
        git(root, ['config', 'user.email', 'blame@example.test']);
        git(root, ['config', 'core.autocrlf', 'false']);
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    it('deduplicates real incremental commit records and leaves changed/added lines uncommitted', async () => {
        await writeFile(join(root, 'file'), 'one\ntwo\nthree\nfour\n');
        const first = await commit('Alice', 'original');
        await writeFile(join(root, 'file'), 'one\ntwo from Bob\nthree\nfour\n');
        const second = await commit('Bob', 'second');
        await writeFile(join(root, 'file'), 'one\ntwo from Bob\nmanual\nfour\nadded\n');
        const result = await blame('file');
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(JSON.stringify(result));
        const commits = result.commits;
        const bySha = (sha: string) => commits.findIndex(item => item.sha === sha);
        expect(result.ranges).toEqual([
            { startLine: 1, lineCount: 1, commitIndex: bySha(first) },
            { startLine: 2, lineCount: 1, commitIndex: bySha(second) },
            { startLine: 3, lineCount: 1, commitIndex: null },
            { startLine: 4, lineCount: 1, commitIndex: bySha(first) },
            { startLine: 5, lineCount: 1, commitIndex: null },
        ]);
        expect(commits).toHaveLength(2);
        expect(commits[bySha(first)]).toMatchObject({ authorName: 'Alice', authorEmail: 'alice@example.test', summary: 'original', authoredAtMs: expect.any(Number), shortSha: first.slice(0, 7) });
        expect(commits[bySha(second)]).toMatchObject({ authorName: 'Bob', summary: 'second' });
        expect(createScmCapabilitiesFromBackendCapabilities(GIT_SCM_BACKEND_CAPABILITIES).readBlame).toBe(true);
    });
    it('follows rename history, preserves CRLF line coordinates and supports empty files', async () => {
        await writeFile(join(root, 'old'), 'alpha\r\nbeta\r\n');
        await writeFile(join(root, 'empty'), '');
        const original = await commit('Alice', 'original');
        await rename(join(root, 'old'), join(root, 'renamed'));
        await commit('Bob', 'rename');
        expect(await blame('renamed')).toMatchObject({ success: true, ranges: [{ startLine: 1, lineCount: 2, commitIndex: 0 }], commits: [{ sha: original }] });
        expect(await blame('empty')).toEqual({ success: true, ranges: [], commits: [] });
    });
    it('fails closed for stale bytes, untracked/unborn paths, binary files and escaping paths', async () => {
        await writeFile(join(root, 'new'), 'untracked\n');
        expect(await blame('new')).toMatchObject({ success: false, errorCode: 'untracked' });
        await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
        await commit('Alice', 'first');
        expect(await blame('binary')).toMatchObject({ success: false, errorCode: 'unsupported_path' });
        const oldHash = createHash('sha256').update('untracked\n').digest('hex');
        expect(await blame('new', oldHash)).toMatchObject({ success: true });
        await writeFile(join(root, 'new'), 'changed\n');
        expect(await blame('new', oldHash)).toMatchObject({ success: false, errorCode: 'stale_file' });
        expect(await blame('../outside')).toMatchObject({ success: false, errorCode: 'INVALID_PATH' });
        await writeFile(join(root, 'another-new'), 'new\n');
        expect(await blame('another-new')).toMatchObject({ success: false, errorCode: 'untracked' });
        await rename(join(root, 'new'), join(root, 'moved'));
        expect(await blame('new', oldHash)).toMatchObject({ success: false, errorCode: 'stale_file' });
    });
    it('parses producer output across arbitrary UTF-8 chunk boundaries and rejects a concurrent write', async () => {
        await writeFile(join(root, 'file'), 'one\ntwo\n');
        await commit('Álice', 'unicode subject 😀');
        const expected = await blame('file');
        const services = createRealGitScmBackendRuntimeServices();
        const chunked = await runWithGitScmCommandRunner(input => {
            if (!('stdoutConsumer' in input)) return services.runCommand(input);
            return services.runCommandStreaming!({ ...input, stdoutConsumer: bytes => {
                for (const byte of bytes) input.stdoutConsumer(Uint8Array.of(byte));
                return 'continue';
            } });
        }, () => reads.gitBlameFile({ context: context(), request: { cwd: root, path: 'file' } }));
        expect(chunked).toEqual(expected);
        const hash = createHash('sha256').update('one\ntwo\n').digest('hex');
        const raced = await runWithGitScmCommandRunner(async input => {
            const response = 'stdoutConsumer' in input ? await services.runCommandStreaming!(input) : await services.runCommand(input);
            if (input.args.includes('blame')) await writeFile(join(root, 'file'), 'human changed\n');
            return response;
        }, () => reads.gitBlameFile({ context: context(), request: { cwd: root, path: 'file', expectedHash: hash } }));
        expect(raced).toMatchObject({ success: false, errorCode: 'stale_file' });
    });
});
