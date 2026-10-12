import { describe, expect, it } from 'vitest';
import {
  describeCreateDirectoryApprovalSummary, describeDeleteApprovalSummary,
  describeRenameApprovalSummary, describeWorkspaceRelativePath,
  describeWriteFileApprovalSummary, projectWriteFileApprovalInput,
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
