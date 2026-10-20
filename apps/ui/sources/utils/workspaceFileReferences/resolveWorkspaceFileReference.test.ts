import { describe, expect, it } from 'vitest';
import { resolveWorkspaceFileReference, resolveWorkspaceMarkdownImage, resolveWorkspaceMarkdownLink } from './resolveWorkspaceFileReference';

describe('workspace Markdown references', () => {
    const context = { workspacePath: '/work/repo', sourceFilePath: 'docs/guide.md' };
    it.each([
        ['./screen.png', 'docs/screen.png'], ['../screen.png', 'screen.png'], ['/images/a.png', 'images/a.png'],
        ['/work/repo/images/a.png', 'images/a.png'], ['a%20b.png?raw=1#preview', 'docs/a b.png'],
    ])('resolves %s using the document and workspace roots', (destination, path) => {
        expect(resolveWorkspaceMarkdownImage({ ...context, destination })).toEqual({ kind: 'workspace', path });
    });
    it.each(['../../private.png', '..%2f..%2fprivate.png', 'file:///work/private.png', 'javascript:alert(1)', '//remote.test/pixel.png'])('blocks %s', destination => {
        expect(resolveWorkspaceMarkdownImage({ ...context, destination })).toEqual({ kind: 'blocked' });
    });
    it('keeps HTTP remote, including loopback, and never turns data into a workspace read', () => {
        expect(resolveWorkspaceMarkdownImage({ ...context, destination: 'http://localhost/a.png' })).toEqual({ kind: 'remote', url: 'http://localhost/a.png' });
        expect(resolveWorkspaceMarkdownImage({ ...context, destination: 'data:image/png;base64,YQ==' })).toEqual({ kind: 'blocked' });
    });
    it('uses Windows Machine paths regardless of UI platform and rejects sibling-root collisions', () => {
        expect(resolveWorkspaceMarkdownImage({ workspacePath: 'C:\\Repo', sourceFilePath: 'docs\\guide.md', destination: 'c:/REPO/images/A.png' })).toEqual({ kind: 'workspace', path: 'images/A.png' });
        expect(resolveWorkspaceMarkdownImage({ workspacePath: 'C:\\Repo', sourceFilePath: 'docs/guide.md', destination: 'C:/Repo2/a.png' })).toEqual({ kind: 'blocked' });
        expect(resolveWorkspaceMarkdownImage({ workspacePath: '\\\\server\\share\\Repo', sourceFilePath: 'docs/guide.md', destination: '../images/A.png' })).toEqual({ kind: 'workspace', path: 'images/A.png' });
    });
    it('preserves filesystem-root workspace identities when joining document-relative paths', () => {
        expect(resolveWorkspaceMarkdownImage({ workspacePath: '/', sourceFilePath: 'docs/guide.md', destination: '../screen.png' })).toEqual({ kind: 'workspace', path: 'screen.png' });
        expect(resolveWorkspaceMarkdownImage({ workspacePath: 'C:/', sourceFilePath: 'docs/guide.md', destination: '../screen.png' })).toEqual({ kind: 'workspace', path: 'screen.png' });
    });
    it('classifies anchors, remote links, Markdown files and other files without losing colon filenames', () => {
        expect(resolveWorkspaceMarkdownLink({ ...context, destination: '#heading' })).toEqual({ kind: 'anchor', anchor: 'heading' });
        expect(resolveWorkspaceMarkdownLink({ ...context, destination: 'https://example.test/a.pdf' })).toEqual({ kind: 'external', url: 'https://example.test/a.pdf' });
        expect(resolveWorkspaceMarkdownLink({ ...context, destination: '../README.md:12:3' })).toEqual({ kind: 'markdown', path: 'README.md', line: 12, column: 3 });
        expect(resolveWorkspaceMarkdownLink({ ...context, destination: 'spec:draft.pdf' })).toEqual({ kind: 'file', path: 'docs/spec:draft.pdf' });
    });
    it('normalizes transcript git quoting, query strings and file URLs through the existing owner', () => {
        expect(resolveWorkspaceFileReference({ workspacePath: '/work/repo', url: '"caf\\303\\251.txt"' })?.filePath).toBe('café.txt');
        expect(resolveWorkspaceFileReference({ workspacePath: '/work/repo', url: '"folder\\134test.txt"' })?.filePath).toBe('folder/test.txt');
        expect(resolveWorkspaceFileReference({ workspacePath: 'C:/Repo', url: 'file:///c:/REPO/src/a.ts?raw=1#L12' })).toMatchObject({ filePath: 'src/a.ts', line: 12 });
    });
});
