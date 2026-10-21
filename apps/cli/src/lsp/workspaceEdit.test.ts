import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { normalizeWorkspaceEdit } from './workspaceEdit';

describe('LSP workspace edit normalization', () => {
    it('keeps ordered edits after a RenameFile on the original guarded source without writing', async () => {
        await withTempDir('happier-lsp-resource-edit-', async rootPath => {
            const bytes = Buffer.from('\uFEFFold\r\n');
            await writeFile(join(rootPath, 'a.ts'), bytes);
            const oldUri = pathToFileURL(join(rootPath, 'a.ts')).href;
            const newUri = pathToFileURL(join(rootPath, 'moved.ts')).href;
            const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } };
            const files = await normalizeWorkspaceEdit({ rootPath, platform: process.platform, document: () => undefined,
                edit: { documentChanges: [
                    { kind: 'rename', oldUri, newUri, options: { overwrite: false } },
                    { textDocument: { uri: newUri, version: null }, edits: [{ range, newText: 'x' }, { range, newText: 'x' }] },
                ] },
            });
            expect(files).toEqual([{ path: 'a.ts', renameTo: 'moved.ts', expectedHash: createHash('sha256').update(bytes).digest('hex'),
                edits: [{ range, text: 'x' }, { range, text: 'x' }],
            }]);
            expect(await readFile(join(rootPath, 'a.ts'))).toEqual(bytes);
            await expect(readFile(join(rootPath, 'moved.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
});
