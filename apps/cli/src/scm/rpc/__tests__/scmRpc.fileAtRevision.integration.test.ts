import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmFileAtRevisionResponseSchema, type ScmFileAtRevisionRequest, type ScmFileAtRevisionResponse } from '@happier-dev/protocol/scm';
import { createTestGitRpcManager, runGit } from './testRpcHarness';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('SCM base-revision read through registered RPC and Action', () => {
    it('returns committed binary bytes and hash, preserves areas and caller admission', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-file-revision-rpc-')); roots.push(root);
        runGit(root, ['init']);
        runGit(root, ['config', 'user.name', 'Revision Reader']);
        runGit(root, ['config', 'user.email', 'revision@example.test']);
        const path = 'image [before].png';
        const committed = Buffer.from([0, 255, 128, 13, 10, 0, 1]);
        writeFileSync(join(root, path), committed);
        runGit(root, ['--literal-pathspecs', 'add', '--', path]);
        runGit(root, ['commit', '-m', 'image']);
        const blobId = runGit(root, ['rev-parse', `HEAD:${path}`]).trim();
        writeFileSync(join(root, path), Buffer.from([0, 254, 2]));
        runGit(root, ['--literal-pathspecs', 'add', '--', path]);
        writeFileSync(join(root, path), Buffer.from([0, 253, 3]));
        const { call } = createTestGitRpcManager({ workingDirectory: root });
        const read = async (selector: ScmFileAtRevisionRequest['selector'], maxBytes?: number) =>
            ScmFileAtRevisionResponseSchema.parse(await call<ScmFileAtRevisionResponse, ScmFileAtRevisionRequest>(
                RPC_METHODS.SCM_FILE_READ, { cwd: root, path, selector, ...(maxBytes === undefined ? {} : { maxBytes }) }));
        const response = await read({ blobId });
        expect(response).toEqual({ success: true, contentBase64: committed.toString('base64'), sizeBytes: committed.length,
            sha256: createHash('sha256').update(committed).digest('hex') });
        expect(await read({ side: 'before', area: 'both' })).toEqual(response);
        expect(await read({ side: 'before', area: 'included' })).toEqual(response);
        expect(await read({ side: 'before', area: 'pending' })).toMatchObject({ success: true, contentBase64: Buffer.from([0, 254, 2]).toString('base64') });
        expect(await read({ blobId }, committed.length - 1)).toMatchObject({ success: false, errorCode: 'too_large' });
        expect(await read({ blobId }, committed.length)).toEqual(response);
        expect(await read({ blobId: '0'.repeat(40) })).toMatchObject({ success: false, errorCode: 'blob_unavailable' });
    });
});
