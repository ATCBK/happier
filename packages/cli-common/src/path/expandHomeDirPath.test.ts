import { describe, expect, it } from 'vitest';

import {
  canonicalAbsolutePathsEqual,
  createCanonicalAbsolutePathComparator,
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
  resolveCanonicalAbsolutePath,
  resolveHomeDirFromEnvironment,
} from './expandHomeDirPath.js';

describe('expandHomeDirPath', () => {
  it('reuses the canonical equality and containment decisions for one read', () => {
    const compare = createCanonicalAbsolutePathComparator();
    for (const [root, child, equal, inside] of [
      ['/home/alice', '/home/alice/../alice/project', false, true],
      ['/home/alice', '/home/alice2/project', false, false],
      ['/home/Alice', '/home/alice/project', false, false],
      ['C:\\Users\\Alice', 'c:/users/alice/project', false, true],
      ['C:\\Users\\Alice', 'c:/users/alice', true, true],
      ['C:\\Users\\Alice', 'C:\\Users\\Alice2\\project', false, false],
      ['C:\\Users\\Alice', 'D:\\Users\\Alice\\project', false, false],
      ['\\\\server\\share\\Alice', '//SERVER/share/alice/project', false, true],
      ['/home/alice', 'C:\\Users\\Alice', false, false],
      ['relative', 'relative/child', false, false],
    ] as const) {
      expect(compare.equal(root, child)).toBe(equal);
      expect(compare.contains(root, child)).toBe(inside);
      expect(compare.contains(child, root)).toBe(equal);
    }
    const first = createCanonicalAbsolutePathComparator({ platform: 'linux', env: { HOME: '/home/first' } });
    const second = createCanonicalAbsolutePathComparator({ platform: 'linux', env: { HOME: '/home/second' } });
    expect(first.contains('~', '/home/first/project')).toBe(true);
    expect(second.contains('~', '/home/first/project')).toBe(false);
    expect(second.contains('~', '/home/second/project')).toBe(true);
    const windows = createCanonicalAbsolutePathComparator({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\Alice' } });
    expect(windows.equal('~\\projects//app', 'c:/users/alice/projects/app')).toBe(true);
    expect(windows.contains('~\\', 'C:/Users/Alice/projects/app')).toBe(true);
    expect(windows.contains('~\\', 'C:/Users/Alice2/projects/app')).toBe(false);
  });
  it.each([
    {
      label: 'Windows forward-slash prefix and mixed separators',
      value: '~/projects\\happier/src',
      env: { USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
      expected: 'C:\\Users\\alice\\projects\\happier\\src',
    },
    {
      label: 'Windows backslash prefix and repeated separators',
      value: '~\\projects//happier\\\\src',
      env: { USERPROFILE: 'C:\\Users\\alice' },
      platform: 'win32',
      expected: 'C:\\Users\\alice\\projects\\happier\\src',
    },
    {
      label: 'POSIX forward-slash prefix and mixed separators',
      value: '~/projects\\happier/src',
      env: { HOME: '/Users/alice' },
      platform: 'darwin',
      expected: '/Users/alice/projects/happier/src',
    },
  ] as const)('$label', ({ value, env, platform, expected }) => {
    expect(expandHomeDirPath(value, env, platform)).toBe(expected);
  });

  it('prefers USERPROFILE on Windows and HOME on POSIX', () => {
    const env = {
      HOME: '/home/alice',
      USERPROFILE: 'C:\\Users\\alice',
    };

    expect(resolveHomeDirFromEnvironment(env, 'win32')).toBe('C:\\Users\\alice');
    expect(resolveHomeDirFromEnvironment(env, 'linux')).toBe('/home/alice');
  });

  it('leaves paths without a home prefix unchanged', () => {
    expect(expandHomeDirPath('C:\\Users\\alice2\\project', {}, 'win32')).toBe(
      'C:\\Users\\alice2\\project',
    );
  });

  it('keeps dot-prefixed child names and home-like sibling prefixes distinct', () => {
    const env = { HOME: '/Users/alice' };

    expect(expandHomeDirPath('~/..build/projects', env, 'linux')).toBe(
      '/Users/alice/..build/projects',
    );
    expect(expandHomeDirPath('~alice/projects', env, 'linux')).toBe('~alice/projects');
  });

  it('contains mixed-separator Windows children without rejecting dot-prefixed names or accepting siblings', () => {
    const root = 'C:\\Users\\Alice\\project';

    expect(isCanonicalAbsolutePathInsideRoot(
      root,
      'c:/users/alice/project\\build/output.js',
    )).toBe(true);
    expect(isCanonicalAbsolutePathInsideRoot(
      root,
      'C:\\Users\\Alice\\project\\..build\\output.js',
    )).toBe(true);
    expect(isCanonicalAbsolutePathInsideRoot(
      root,
      'C:\\Users\\Alice\\project-other\\output.js',
    )).toBe(false);
  });

  it('normalizes Windows identity without weakening POSIX case-sensitive identity', () => {
    expect(resolveCanonicalAbsolutePath(
      '~\\projects/mixed/../acme',
      { env: { USERPROFILE: 'C:\\Users\\Alice' }, platform: 'win32' },
    )).toEqual({
      path: 'C:\\Users\\Alice\\projects\\acme',
      comparisonKey: 'c:\\users\\alice\\projects\\acme',
    });
    expect(canonicalAbsolutePathsEqual(
      'C:\\Users\\Alice\\projects\\acme',
      'c:/users/alice/PROJECTS/ACME',
    )).toBe(true);
    expect(canonicalAbsolutePathsEqual('/Users/Alice/acme', '/users/alice/acme')).toBe(false);
  });
});
