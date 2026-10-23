import { describe, expect, it } from 'vitest';
import { createPdfViewPosition } from './pdfViewPosition';

describe('PDF view restoration', () => {
    it('ignores provisional restore locations, clamps a shrinking document and flushes the final location', () => {
        const restored: unknown[] = []; const saved: unknown[] = [];
        const position = createPdfViewPosition({ initial: { page: 14, top: 800, left: 20 }, restore: value => restored.push(value), persist: value => saved.push(value) });
        position.pagesInit(10);
        position.locationChanged({ page: 1, top: 0, left: 0 });
        position.pagesLoaded(10);
        expect(restored).toEqual([{ page: 10, top: 800, left: 20 }, { page: 10, top: 800, left: 20 }]);
        position.locationChanged({ page: 8, top: 150, left: 0 }); position.dispose();
        expect(saved).toEqual([{ page: 8, top: 150, left: 0 }]);
    });
    it('never restores over a reader movement during loading', () => {
        const restored: unknown[] = []; const saved: unknown[] = [];
        const position = createPdfViewPosition({ initial: { page: 4, top: 20, left: 0 }, restore: value => restored.push(value), persist: value => saved.push(value) });
        position.pagesInit(5); position.readerMoved(); position.locationChanged({ page: 2, top: 400, left: 0 }); position.pagesLoaded(5); position.dispose();
        expect(restored).toHaveLength(1);
        expect(saved).toEqual([{ page: 2, top: 400, left: 0 }]);
    });
    it('writes each location to the tab as it changes, so another viewer of the same tab opens there', () => {
        const saved: unknown[] = [];
        const position = createPdfViewPosition({ initial: null, restore: () => {}, persist: value => saved.push(value) });
        position.pagesLoaded(5);
        position.locationChanged({ page: 3, top: 400, left: 175 });
        // Written before this viewer closes: a second viewer of the tab mounting now reads it.
        expect(saved).toEqual([{ page: 3, top: 400, left: 175 }]);
        position.locationChanged({ page: 3, top: 400, left: 175 });
        position.dispose();
        expect(saved).toEqual([{ page: 3, top: 400, left: 175 }]);
    });
    it('follows a location another viewer of the tab wrote, and never writes its own older one over it', () => {
        const restored: unknown[] = []; const saved: unknown[] = [];
        const position = createPdfViewPosition({ initial: null, restore: value => restored.push(value), persist: value => saved.push(value) });
        position.pagesLoaded(5);
        position.locationChanged({ page: 1, top: 40, left: 0 });
        position.adopt({ page: 4, top: 120, left: 16 });
        expect(restored).toEqual([{ page: 4, top: 120, left: 16 }]);
        // Its own write coming back through the tab is not news.
        position.adopt({ page: 4, top: 120, left: 16 });
        expect(restored).toHaveLength(1);
        position.dispose();
        expect(saved).toEqual([{ page: 1, top: 40, left: 0 }]);
    });
});
