import { describe, expect, it } from 'vitest';

import { isWorkspacePathWithinRootV1, normalizeWorkspaceRootPathV1 } from './workspaceRefResolutionV1.js';

describe('workspace path comparisons', () => {
  it('uses the supplied platform rather than the path spelling for case sensitivity', () => {
    expect(normalizeWorkspaceRootPathV1('/Repo', 'win32')).toBe('/repo');
    expect(normalizeWorkspaceRootPathV1('C:/Repo', 'posix')).toBe('C:/Repo');
    expect(normalizeWorkspaceRootPathV1('C:\\Repo')).toBe('c:/repo');
    expect(normalizeWorkspaceRootPathV1('/Repo')).toBe('/Repo');
  });

  it('contains Windows descendants with mixed separators and drive case', () => {
    expect(isWorkspacePathWithinRootV1('c:\\repo\\x', 'C:\\Repo', 'win32')).toBe(true);
    expect(isWorkspacePathWithinRootV1('c:/REPO\\x', 'C:\\Repo')).toBe(true);
    expect(isWorkspacePathWithinRootV1('C:\\Users\\alice2', 'C:\\Users\\alice', 'win32')).toBe(false);
    expect(isWorkspacePathWithinRootV1('C:\\other', 'C:\\Repo', 'win32')).toBe(false);
    expect(isWorkspacePathWithinRootV1('C:\\Repo', 'C:\\', 'win32')).toBe(true);
  });

  it('compares POSIX paths exactly and keeps the separator boundary', () => {
    expect(isWorkspacePathWithinRootV1('/Repo/x', '/Repo/', 'posix')).toBe(true);
    expect(isWorkspacePathWithinRootV1('/Repo', '/Repo', 'posix')).toBe(true);
    expect(isWorkspacePathWithinRootV1('/repo/x', '/Repo', 'posix')).toBe(false);
    expect(isWorkspacePathWithinRootV1('/Repo2', '/Repo', 'posix')).toBe(false);
    expect(isWorkspacePathWithinRootV1('/Repo', '/', 'posix')).toBe(true);
    expect(isWorkspacePathWithinRootV1('/Repo', '', 'posix')).toBe(false);
  });

  it('compares UNC and extended Windows paths through the same owner', () => {
    expect(isWorkspacePathWithinRootV1('\\\\SERVER\\Share\\Repo\\x', '\\\\server\\share\\repo', 'win32')).toBe(true);
    expect(isWorkspacePathWithinRootV1('\\\\?\\C:\\Repo\\x', 'c:\\repo', 'win32')).toBe(true);
    expect(isWorkspacePathWithinRootV1('\\\\?\\UNC\\SERVER\\Share\\Repo\\x', '\\\\server\\share\\repo', 'win32')).toBe(true);
    expect(isWorkspacePathWithinRootV1('\\\\server\\share2\\x', '\\\\server\\share', 'win32')).toBe(false);
  });
});
