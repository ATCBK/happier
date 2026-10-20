import type { PdfWebViewMessage } from './pdfNativeBridge';
import type { PdfFindSnapshot, PdfFindSurfaceModel } from './pdfFindModel';

/** A projection of the page's single search owner; no PDF text or matching lives in the host. */
export function createPdfBridgeFindModel(injectJavaScript: (script: string) => void) {
    let snapshot: PdfFindSnapshot = { open: false, query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' }, matches: [], current: null };
    const listeners = new Set<() => void>();
    const publish = (update: Partial<PdfFindSnapshot>) => { snapshot = { ...snapshot, ...update }; for (const listener of listeners) listener(); };
    const dispatch = () => {
        publish({ status: snapshot.query ? { kind: 'searching', total: 0 } : { kind: 'idle' } });
        injectJavaScript(`window.__pdfFind(${JSON.stringify(snapshot.query)},${snapshot.options.matchCase});true;`);
    };
    const model: PdfFindSurfaceModel & Readonly<{ acceptMessage(message: PdfWebViewMessage): void }> = {
        get query() { return snapshot.query; }, get options() { return snapshot.options; }, get status() { return snapshot.status; },
        capabilities: { regex: false, stop: false }, getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        open() { publish({ open: true }); if (snapshot.query) dispatch(); },
        setQuery(query) { publish({ open: true, query }); dispatch(); },
        setOptions(options) { if (options.matchCase === snapshot.options.matchCase) return; publish({ options: { matchCase: options.matchCase, regex: false } }); dispatch(); },
        step(direction) { injectJavaScript(`window.__pdfStep(${direction});true;`); },
        stop() {},
        close() { publish({ open: false, status: { kind: 'idle' } }); injectJavaScript('window.__pdfFind("",false);true;'); },
        acceptMessage(message) {
            if (message.type !== 'find' || !snapshot.open || !snapshot.query) return;
            publish({ status: message.complete ? { kind: 'results', current: message.current || null, total: message.total, coverage: 'complete' }
                : { kind: 'searching', current: message.current || null, total: message.total } });
        },
    };
    return model;
}
