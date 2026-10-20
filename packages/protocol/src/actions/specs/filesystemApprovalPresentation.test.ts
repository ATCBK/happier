import { describe, expect, it } from 'vitest';
import {
  describeCreateDirectoryApprovalSummary, describeDeleteApprovalSummary,
  describeRenameApprovalSummary, describeWorkspaceRelativePath,
  describeUploadApprovalSummary, describeWriteFileApprovalSummary, projectWriteFileApprovalInput,
} from './filesystemApprovalPresentation.js';

describe('filesystem approval literal operands', () => {
  it.each([' report', 'report ', 'two words', 'line\nbreak', 'tab\tname'])('distinguishes %j from its whitespace-stripped sibling', path => {
    const input = { rootPath: '/workspace', path: `/workspace/${path}`, content: '' };
    const displayed = JSON.stringify(path);
    expect(projectWriteFileApprovalInput(input)).toMatchObject({ path: displayed });
    expect(describeWriteFileApprovalSummary(input)).toBe(`Write ${displayed} in workspace`);
    expect(describeCreateDirectoryApprovalSummary(input)).toBe(`Create the folder ${displayed} in workspace`);
    expect(describeRenameApprovalSummary({ rootPath: '/workspace', from: input.path, to: '/workspace/plain' }))
      .toBe(`Rename ${displayed} to plain in workspace`);
    expect(describeDeleteApprovalSummary({ ...input, recursive: true })).toBe(`Delete ${displayed} and everything in it from workspace`);
  });

  it('retains a spaced checkout name and Windows path segments without confusing sibling roots', () => {
    expect(describeWorkspaceRelativePath('C:\\work\\repo ', 'C:\\work\\repo \\file ')).toBe('"file "');
    expect(describeWriteFileApprovalSummary({ rootPath: 'C:\\work\\repo ', path: 'C:\\work\\repo \\file ', expectedHash: 'hash' }))
      .toBe('Save changes to "file " in "repo "');
    expect(describeWorkspaceRelativePath('/repo', '/repo2/file ')).toBe('"/repo2/file "');
  });

  it('keeps ordinary names readable and rejects empty operands', () => {
    expect(describeWorkspaceRelativePath('/repo', '/repo/readme.md')).toBe('readme.md');
    expect(describeWorkspaceRelativePath('/repo', '/repo')).toBe('.');
    expect(describeWriteFileApprovalSummary({ rootPath: '/repo', path: '  ' })).toBeNull();
    expect(describeRenameApprovalSummary({ from: 3, to: 'file' })).toBeNull();
  });
});

describe('filesystem approval summaries for the checkout folder itself', () => {
  const root = { rootPath: '/home/happier/mqa2-c14-clone', path: '/home/happier/mqa2-c14-clone' };

  it('names the folder instead of leaving a lone dot in the sentence', () => {
    expect(describeWriteFileApprovalSummary({ ...root, content: '' })).toBe('Write mqa2-c14-clone');
    expect(describeCreateDirectoryApprovalSummary(root)).toBe('Create the folder mqa2-c14-clone');
    expect(describeDeleteApprovalSummary({ ...root, recursive: true })).toBe('Delete mqa2-c14-clone and everything in it');
  });

  it('keeps a file inside the checkout named by its checkout', () => {
    expect(describeWriteFileApprovalSummary({ rootPath: root.rootPath, path: `${root.rootPath}/a.txt` })).toBe('Write a.txt in mqa2-c14-clone');
  });
});


describe('upload approval summary', () => {
  const source = { sourceId: 'source', sizeBytes: 4 };

  it('names the file, its size and the checkout it lands in', () => {
    expect(describeUploadApprovalSummary({ rootPath: '/home/happier/repo', path: '/home/happier/repo/upload-dir/a.txt', source, overwrite: false }))
      .toBe('Upload upload-dir/a.txt (4 bytes) to repo');
    expect(describeUploadApprovalSummary({ rootPath: '/repo', path: '/repo/big.bin', source: { ...source, sizeBytes: 3 * 1024 * 1024 }, overwrite: true }))
      .toBe('Upload and replace big.bin (3 MB) to repo');
  });

  it('is absent without a destination, so the generic title stays the only copy', () => {
    expect(describeUploadApprovalSummary({ rootPath: '/repo', source })).toBeNull();
  });
});
