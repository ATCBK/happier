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
});
