import { act, renderHook } from '@/dev/testkit';
import { describe, expect, it, vi } from 'vitest';

import { useFilesystemTreeScrollAnchor } from './useFilesystemTreeScrollAnchor';

describe('filesystem tree scroll anchor', () => {
    it('keeps the top visible path when reconciliation inserts or removes rows above it', async () => {
        const scrollToIndex = vi.fn();
        const listRef = { current: { scrollToIndex } };
        const original = [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }];
        const hook = await renderHook(({ nodes, scopeKey }) => useFilesystemTreeScrollAnchor({ nodes, scopeKey, listRef }), {
            initialProps: { nodes: original, scopeKey: 'one' },
        });
        await act(async () => { hook.getCurrent()([original[1], original[2]]); });
        await hook.rerender({ nodes: [{ path: 'added.ts' }, ...original], scopeKey: 'one' });
        expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 2, animated: false, viewPosition: 0 });
        await hook.rerender({ nodes: original.slice(1), scopeKey: 'one' });
        expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: false, viewPosition: 0 });
        scrollToIndex.mockClear();
        await hook.rerender({ nodes: [...original.slice(1), { path: 'after.ts' }], scopeKey: 'one' });
        expect(scrollToIndex).not.toHaveBeenCalled();
        await hook.rerender({ nodes: original, scopeKey: 'other-workspace' });
        expect(scrollToIndex).not.toHaveBeenCalled();
    });
});
