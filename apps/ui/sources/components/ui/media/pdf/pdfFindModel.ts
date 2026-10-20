import { matchFindText, type FindController, type FindOptions, type FindStatus } from '@happier-dev/plugin-ui/presentation';

export type PdfFindMatch = Readonly<{ page: number; start: number; end: number }>;
export interface PdfFindDocument {
    readonly numPages: number;
    getPage(page: number): Promise<{ getTextContent(): Promise<{ items: ReadonlyArray<{ str: string; hasEOL?: boolean } | object> }> }>;
}
export type PdfFindSnapshot = Readonly<{
    open: boolean; query: string; options: FindOptions; status: FindStatus;
    matches: readonly PdfFindMatch[]; current: PdfFindMatch | null;
}>;
export type PdfFindSurfaceModel = FindController & Readonly<{
    subscribe(listener: () => void): () => void; getSnapshot(): PdfFindSnapshot; open(): void;
}>;

/** Search pdf.js text on every page, independently of whether a page has a mounted canvas. */
export function createPdfFindModel(options: Readonly<{ reveal(match: PdfFindMatch): void }>) {
    let document: PdfFindDocument | null = null;
    let snapshot: PdfFindSnapshot = { open: false, query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' }, matches: [], current: null };
    let extraction = Promise.resolve();
    let pages = new Map<number, Promise<string>>();
    let search: object | null = null;
    let settled = Promise.resolve();
    let current = -1;
    let coverage: 'complete' | 'partialErrors' | 'limited' = 'complete';
    const listeners = new Set<() => void>();
    const publish = (update: Partial<PdfFindSnapshot>) => { snapshot = { ...snapshot, ...update }; for (const listener of listeners) listener(); };
    const results = (complete = true) => publish({ current: snapshot.matches[current] ?? null,
        status: complete ? { kind: 'results', current: current < 0 ? null : current + 1, total: snapshot.matches.length, coverage }
            : { kind: 'searching', current: current < 0 ? null : current + 1, total: snapshot.matches.length } });
    const text = (source: PdfFindDocument, page: number) => {
        let pending = pages.get(page);
        if (!pending) {
            pending = extraction.then(async () => {
                const content = await (await source.getPage(page)).getTextContent();
                return content.items.map(item => 'str' in item && typeof item.str === 'string'
                    ? item.str + ('hasEOL' in item && item.hasEOL ? '\n' : '') : '').join('');
            });
            // One extraction chain; a failed page must not prevent searching later pages.
            extraction = pending.then(() => {}, () => {});
            pages.set(page, pending);
        }
        return pending;
    };
    const refresh = () => {
        const identity = {}; search = identity; current = -1; coverage = 'complete';
        publish({ matches: [], current: null });
        const source = document;
        if (!snapshot.open || !snapshot.query) { publish({ status: { kind: 'idle' } }); settled = Promise.resolve(); return; }
        if (!source) { publish({ status: { kind: 'unavailable', reason: 'unsupportedEngine' } }); settled = Promise.resolve(); return; }
        const { query, options: findOptions } = snapshot;
        if ('invalidPattern' in matchFindText('', query, findOptions)) { publish({ status: { kind: 'invalidPattern' } }); settled = Promise.resolve(); return; }
        publish({ status: { kind: 'searching', total: 0 } });
        settled = (async () => {
            const matches: PdfFindMatch[] = [];
            for (let page = 1; page <= source.numPages; page++) {
                try {
                    const pageText = await text(source, page);
                    if (search !== identity) return;
                    const found = matchFindText(pageText, query, findOptions);
                    if ('ranges' in found) matches.push(...found.ranges.map(([start, end]) => ({ page, start, end })));
                } catch {
                    if (search !== identity) return;
                    coverage = 'partialErrors';
                }
                if (search !== identity) return;
                const first = current < 0 && matches.length > 0;
                if (first) current = 0;
                publish({ matches: [...matches], current: matches[current] ?? null,
                    status: { kind: 'searching', total: matches.length, current: current < 0 ? null : current + 1 } });
                if (first) options.reveal(matches[0]!);
            }
            if (search === identity) results();
        })();
    };
    const controller: FindController & Readonly<{
        subscribe(listener: () => void): () => void; getSnapshot(): PdfFindSnapshot;
        setDocument(next: PdfFindDocument | null): void; open(): void; whenSettled(): Promise<void>;
    }> = {
        get query() { return snapshot.query; }, get options() { return snapshot.options; }, get status() { return snapshot.status; },
        capabilities: { regex: true, stop: true },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSnapshot: () => snapshot,
        setDocument(next) { if (next === document) return; document = next; pages = new Map(); extraction = Promise.resolve(); refresh(); },
        open() { if (!snapshot.open) { publish({ open: true }); refresh(); } },
        setQuery(query) { if (snapshot.open && query === snapshot.query) return; publish({ open: true, query }); refresh(); },
        setOptions(findOptions) { if (findOptions.matchCase === snapshot.options.matchCase && findOptions.regex === snapshot.options.regex) return; publish({ options: findOptions }); refresh(); },
        step(direction) {
            if (!snapshot.matches.length) return;
            current = (current + direction + snapshot.matches.length) % snapshot.matches.length;
            results(snapshot.status.kind !== 'searching'); options.reveal(snapshot.matches[current]!);
        },
        stop() { search = null; coverage = 'limited'; results(); },
        close() { search = null; current = -1; publish({ open: false, matches: [], current: null, status: { kind: 'idle' } }); },
        whenSettled: () => settled,
    };
    return controller;
}
