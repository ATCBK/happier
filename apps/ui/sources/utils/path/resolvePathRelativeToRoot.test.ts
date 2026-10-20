import { expect, it } from 'vitest';
import { resolvePathRelativeToRoot } from './resolvePathRelativeToRoot';

it('projects contained relative spelling without replacing canonical Windows containment', () => {
    expect(resolvePathRelativeToRoot({ root: 'C:\\Repo', path: 'c:/REPO/Sub Dir /Nested', preservePathSpelling: true }))
        .toBe('Sub Dir /Nested');
    expect(resolvePathRelativeToRoot({ root: 'C:\\', path: 'c:/Sub', preservePathSpelling: true })).toBe('Sub');
    expect(resolvePathRelativeToRoot({ root: '//Server/Share/Repo', path: '\\\\server\\SHARE\\repo\\Sub', preservePathSpelling: true }))
        .toBe('Sub');
    expect(resolvePathRelativeToRoot({ root: '/repo', path: '/repo/ leading\nfolder ', preservePathSpelling: true }))
        .toBe(' leading\nfolder ');
    expect(resolvePathRelativeToRoot({ root: '/repo', path: '/repo-other/Sub', preservePathSpelling: true })).toBeNull();
    expect(resolvePathRelativeToRoot({ root: 'C:\\Repo', path: 'D:\\Repo\\Sub', preservePathSpelling: true })).toBeNull();
});

it('preserves a whitespace-only filename in absolute raw paths without changing ordinary root trimming', () => {
    expect(resolvePathRelativeToRoot({ root: '/repo', path: '/repo/ ', preservePathSpelling: true })).toBe(' ');
    expect(resolvePathRelativeToRoot({ root: '/repo', path: '/repo/\n', preservePathSpelling: true })).toBe('\n');
    expect(resolvePathRelativeToRoot({ root: ' /repo ', path: '/repo/ ', preservePathSpelling: true })).toBe(' ');
    expect(resolvePathRelativeToRoot({ root: '/repo', path: ' /repo/src/a.ts ' })).toBe('src/a.ts');
});
