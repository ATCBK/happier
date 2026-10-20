import { describe, expect, it } from 'vitest';
import { createPdfFindModel } from './pdfFindModel';

describe('PDF find across unrendered pages', () => {
    it('keeps progressive coverage when stepping before later pages finish', async () => {
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        const model = createPdfFindModel({ reveal: () => {} });
        model.setDocument({ numPages: 2, getPage: async page => ({ getTextContent: async () => {
            if (page === 2) await waiting;
            return { items: [{ str: 'retry retry' }] };
        } }) });
        model.setQuery('retry');
        await new Promise<void>(resolve => {
            const stop = model.subscribe(() => { if (model.getSnapshot().matches.length === 2) { stop(); resolve(); } });
        });
        model.step(1);
        expect(model.status).toEqual({ kind: 'searching', total: 2, current: 2 });
        release(); await model.whenSettled();
        expect(model.status).toEqual({ kind: 'results', total: 4, current: 2, coverage: 'complete' });
    });
    it('extracts pages sequentially, publishes counts and reveals next/previous matches', async () => {
        let extracting = 0;
        let maximum = 0;
        const revealed: number[] = [];
        const model = createPdfFindModel({ reveal: (match) => revealed.push(match.page) });
        model.setDocument({ numPages: 3, getPage: async (page) => ({ getTextContent: async () => {
            extracting++; maximum = Math.max(maximum, extracting);
            await Promise.resolve(); extracting--;
            return { items: [{ str: page === 2 ? 'retry retry' : 'retry' }] };
        } }) });
        model.setQuery('retry');
        await model.whenSettled();
        expect(maximum).toBe(1);
        expect(model.status).toEqual({ kind: 'results', total: 4, current: 1, coverage: 'complete' });
        model.step(1); model.step(1); model.step(-1);
        expect(revealed).toEqual([1, 2, 2, 2]);
        model.close();
        expect(model.getSnapshot().open).toBe(false);
        expect(model.status).toEqual({ kind: 'idle' });
    });

    it('drops obsolete extraction results on query/document changes and reports failed page coverage', async () => {
        let release!: () => void;
        const oldPage = new Promise<void>(resolve => { release = resolve; });
        const model = createPdfFindModel({ reveal: () => {} });
        model.setDocument({ numPages: 1, getPage: async () => ({ getTextContent: async () => { await oldPage; return { items: [{ str: 'old' }] }; } }) });
        model.setQuery('old');
        model.setDocument({ numPages: 2, getPage: async (page) => {
            if (page === 2) throw new Error('unreadable page');
            return { getTextContent: async () => ({ items: [{ str: 'new' }] }) };
        } });
        model.setQuery('new'); release();
        await model.whenSettled();
        expect(model.status).toEqual({ kind: 'results', total: 1, current: 1, coverage: 'partialErrors' });
    });
});
