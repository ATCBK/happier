import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolveWorkspacePath, workspacePathToUri, workspaceUriToPath } from './workspaceUris';
import { resolveLanguageServerRoot } from './rootResolution';

describe('language server workspace paths', () => {
    it('maps Windows file URIs with native encoding and the workspace drive case', () => {
        const context = { rootPath: 'C:\\Users\\x\\repo', platform: 'win32' as const };
        const path = "src/a b's#[].ts";
        const uri = workspacePathToUri(context, path);
        expect(uri).toBe("file:///C:/Users/x/repo/src/a%20b's%23%5B%5D.ts");
        expect(workspaceUriToPath(context, uri)).toEqual({ path });
        expect(workspaceUriToPath(context, uri.replace('C:', 'c%3A'))).toEqual({ path });
        expect(resolveWorkspacePath(context, 'src\\nested/a.ts')).toBe('C:\\Users\\x\\repo\\src\\nested\\a.ts');
        expect(workspaceUriToPath(context, 'file:///c%3A/Users/x/repo2/a.ts')).toEqual({
            path: 'C:\\Users\\x\\repo2\\a.ts', outsideWorkspace: true,
        });
        expect(() => resolveWorkspacePath(context, '../repo2/a.ts')).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
        expect(() => resolveWorkspacePath(context, 'C:\\Users\\x\\repo\\a.ts')).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
        expect(() => workspaceUriToPath(context, 'file://server/share/a.ts')).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
        expect(() => workspaceUriToPath(context, 'file:///home/x/repo/a.ts')).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
        expect(() => workspaceUriToPath({ rootPath: '/home/x/repo', platform: 'linux' }, uri)).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
        expect(() => workspacePathToUri({ rootPath: '\\\\server\\share\\repo', platform: 'win32' }, 'a.ts')).toThrowError(expect.objectContaining({ code: 'unsupported_root' }));
    });

    it('uses the rooted filesystem authority for symlinks and topmost markers', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'happier-lsp-paths-'));
        try {
            const rootPath = join(directory, 'repo');
            const outside = join(directory, 'outside');
            await mkdir(join(rootPath, 'packages', 'a', 'src'), { recursive: true });
            await mkdir(outside);
            await writeFile(join(rootPath, 'packages', 'a', 'src', 'file.ts'), 'const value = 1;');
            await writeFile(join(rootPath, 'packages', 'marker.json'), '{}');
            await writeFile(join(rootPath, 'packages', 'a', 'marker.json'), '{}');
            const context = { rootPath };
            expect(await resolveLanguageServerRoot({ ...context, path: 'packages/a/src/file.ts' })).toBe(rootPath);
            expect(await resolveLanguageServerRoot({ ...context, path: 'packages/a/src/file.ts', rootMarkers: ['absent.json'] })).toBe(rootPath);
            expect(await resolveLanguageServerRoot({ ...context, path: 'packages/a/src/file.ts', rootMarkers: ['marker.json'] })).toBe(join(rootPath, 'packages'));
            await writeFile(join(rootPath, 'marker.json'), '{}');
            expect(await resolveLanguageServerRoot({ ...context, path: 'packages/a/src/file.ts', rootMarkers: ['marker.json'] })).toBe(rootPath);
            await symlink(outside, join(rootPath, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
            expect(() => resolveWorkspacePath(context, 'escape/secret.ts')).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
            expect(workspaceUriToPath(context, pathToFileURL(join(rootPath, 'escape', 'secret.ts')).href)).toEqual({ path: join(rootPath, 'escape', 'secret.ts'), outsideWorkspace: true });
            await expect(resolveLanguageServerRoot({ ...context, path: 'escape/secret.ts', rootMarkers: ['marker.json'] })).rejects.toMatchObject({ code: 'invalid_path' });
            expect(() => resolveWorkspacePath({ rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [outside] } }, 'packages/a/src/file.ts')).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
