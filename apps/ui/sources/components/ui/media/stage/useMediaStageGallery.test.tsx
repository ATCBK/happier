import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { useMediaStageGallery } from './useMediaStageGallery';
import type { MediaStageItem } from './mediaStageItems';

describe('media stage gallery lifecycle', () => {
    it('keeps its opened order while navigating and ignores later transcript updates', async () => {
        const items: readonly MediaStageItem[] = ['First', 'Second'].map(title => ({ kind: 'image', title,
            source: { enabled: true, source: { kind: 'uri', uri: `blob:${title}` } } }));
        const hook = await renderHook(({ gallery }) => useMediaStageGallery(gallery, 0), { initialProps: { gallery: items } });
        act(() => hook.getCurrent().next());
        expect(hook.getCurrent().currentItem.title).toBe('Second');
        await hook.rerender({ gallery: items.slice().reverse() });
        expect(hook.getCurrent().currentItem.title).toBe('Second');
        act(() => hook.getCurrent().next());
        expect(hook.getCurrent().index).toBe(1);
        act(() => hook.getCurrent().previous());
        expect(hook.getCurrent().currentItem.title).toBe('First');
    });
});
