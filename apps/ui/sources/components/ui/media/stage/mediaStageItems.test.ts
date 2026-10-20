import { describe, expect, it } from 'vitest';
import { freezeMediaStageGallery, type MediaStageItem } from './mediaStageItems';

describe('media stage gallery snapshot', () => {
    it('preserves the opened gallery and preview identity when the source list changes', () => {
        const source = { enabled: true, source: { kind: 'uri' as const, uri: 'blob:first' }, cacheKey: 'version-one', cacheScopeId: 'workspace' };
        const items: MediaStageItem[] = [{ kind: 'image', title: 'First', source }];
        const opened = freezeMediaStageGallery(items, 0);
        items[0] = { kind: 'image', title: 'Replacement', source: { enabled: true, source: { kind: 'uri', uri: 'blob:new' } } };
        items.push({ kind: 'image', title: 'Later', source: { enabled: true, source: { kind: 'uri', uri: 'blob:later' } } });
        expect(opened.items.map(item => item.title)).toEqual(['First']);
        expect(opened.items[0].source).toBe(source);
        expect(opened.initialIndex).toBe(0);
    });
    it('starts at a valid selected item and rejects an empty gallery', () => {
        const items: MediaStageItem[] = [{ kind: 'image', title: 'One', source: { enabled: true, source: { kind: 'uri', uri: 'blob:one' } } }];
        expect(freezeMediaStageGallery(items, 20).initialIndex).toBe(0);
        expect(() => freezeMediaStageGallery([], 0)).toThrow(RangeError);
    });
});
