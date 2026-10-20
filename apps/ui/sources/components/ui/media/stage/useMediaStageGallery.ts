import * as React from 'react';
import { freezeMediaStageGallery, type MediaStageItem } from './mediaStageItems';

export type MediaStageGallery = Readonly<{
    items: readonly MediaStageItem[];
    index: number;
    currentItem: MediaStageItem;
    select: (index: number) => void;
    previous: () => void;
    next: () => void;
}>;

/** Mount once for an opened stage; subsequent transcript updates cannot reorder it. */
export function useMediaStageGallery(items: readonly MediaStageItem[], initialIndex = 0): MediaStageGallery {
    const [gallery] = React.useState(() => freezeMediaStageGallery(items, initialIndex));
    const [index, setIndex] = React.useState(gallery.initialIndex);
    const select = React.useCallback((next: number) => {
        if (Number.isInteger(next) && next >= 0 && next < gallery.items.length) setIndex(next);
    }, [gallery]);
    const previous = React.useCallback(() => setIndex(current => Math.max(0, current - 1)), []);
    const next = React.useCallback(() => setIndex(current => Math.min(gallery.items.length - 1, current + 1)), [gallery]);
    return { items: gallery.items, index, currentItem: gallery.items[index]!, select, previous, next };
}
