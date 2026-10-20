import { describe, expect, it } from 'vitest';
import { resolveFilesystemTreeScrollAnchorIndex } from './filesystemTreeScrollAnchor';

describe('filesystem tree path anchor', () => {
    it('restores only a surviving reading path whose position changed in the same workspace', () => {
        const previousNodes = [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }];
        const base = { previousNodes, anchorPath: 'b.ts', previousScopeKey: 'one', scopeKey: 'one' };
        expect(resolveFilesystemTreeScrollAnchorIndex({ ...base, nodes: [{ path: 'new.ts' }, ...previousNodes] })).toBe(2);
        expect(resolveFilesystemTreeScrollAnchorIndex({ ...base, nodes: previousNodes.slice(1) })).toBe(0);
        expect(resolveFilesystemTreeScrollAnchorIndex({ ...base, nodes: [...previousNodes, { path: 'after.ts' }] })).toBeNull();
        expect(resolveFilesystemTreeScrollAnchorIndex({ ...base, nodes: previousNodes.slice(1), scopeKey: 'other' })).toBeNull();
        expect(resolveFilesystemTreeScrollAnchorIndex({ ...base, nodes: [{ path: 'a.ts' }] })).toBeNull();
    });
});
