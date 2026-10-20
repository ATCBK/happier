import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfFindMatch } from './pdfFindModel';
import { anchorPdfZoom, resolvePdfCanvasSize } from './pdfZoom';
import { attachWheelZoom } from '../zoom/wheelZoom';
import type { PdfViewPosition } from './pdfViewPosition';
export interface PdfCanvasDocument { readonly numPages: number; getPage(page: number): Promise<Pick<PDFPageProxy, 'getViewport' | 'render' | 'getTextContent'>>; }
type PdfCanvasPage = Awaited<ReturnType<PdfCanvasDocument['getPage']>>;
type Viewport = ReturnType<PdfCanvasPage['getViewport']>;
export interface PdfTextLayerHandle {
    render(): Promise<void>; cancel(): void;
    readonly textDivs: HTMLElement[];
    readonly items: ReadonlyArray<{ str: string; hasEOL?: boolean } | object>;
}
export type PdfTextLayerFactory = (page: PdfCanvasPage, viewport: Viewport, container: HTMLElement) => Promise<PdfTextLayerHandle>;

/** The engine owns only paper slots, canvas/text lifetimes and navigation. Chrome and CSS belong to its wrapper. */
export function createPdfCanvasViewer(input: Readonly<{
    container: HTMLElement; document: PdfCanvasDocument; scale: number;
    signal?: AbortSignal; createTextLayer?: PdfTextLayerFactory;
    onPageChange?(page: number): void; onError?(error: unknown): void;
    onReaderMove?(): void; onLocationChange?(position: PdfViewPosition): void;
    onPagesInit?(pageCount: number): void; onPagesLoaded?(pageCount: number): void;
    onScaleChange?(scale: number): void;
}>) {
    const { container } = input;
    let disposed = false;
    let scale = input.scale;
    let matches: readonly PdfFindMatch[] = [];
    let currentMatch: PdfFindMatch | null = null;
    let pendingReveal: PdfFindMatch | null = null;
    const listeners = new AbortController();
    type Slot = {
        page: number; element: HTMLDivElement; visible: boolean; pageProxy: PdfCanvasPage | null;
        active: object | null; task: ReturnType<PdfCanvasPage['render']> | null; text: PdfTextLayerHandle | null;
    };
    const slots: Slot[] = [];
    const release = (slot: Slot) => {
        slot.active = null;
        slot.task?.cancel(); slot.task = null;
        slot.text?.cancel(); slot.text = null;
        for (const canvas of slot.element.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; }
        slot.element.replaceChildren();
    };
    const reveal = () => {
        if (!pendingReveal) return;
        const slot = slots[pendingReveal.page - 1];
        if (!slot) return;
        const mark = slot.element.querySelector<HTMLElement>('[data-pdf-find-current]');
        if (mark) {
            container.scrollTop += mark.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 3;
            pendingReveal = null;
        } else container.scrollTop = slot.element.offsetTop - container.clientHeight / 3;
    };
    const highlight = (slot: Slot) => {
        if (!slot.text) return;
        const ranges = matches.filter(match => match.page === slot.page);
        let offset = 0;
        let divIndex = 0;
        for (const item of slot.text.items) {
            if (!('str' in item) || typeof item.str !== 'string') continue;
            const div = slot.text.textDivs[divIndex++];
            const end = offset + item.str.length;
            if (div) {
                div.replaceChildren();
                let cursor = 0;
                for (const range of ranges) {
                    const start = Math.max(0, range.start - offset);
                    const stop = Math.min(item.str.length, range.end - offset);
                    if (start >= stop) continue;
                    div.append(container.ownerDocument.createTextNode(item.str.slice(cursor, start)));
                    const mark = container.ownerDocument.createElement('mark');
                    mark.dataset.pdfFindMatch = '';
                    if (currentMatch === range) mark.dataset.pdfFindCurrent = '';
                    mark.textContent = item.str.slice(start, stop); div.append(mark); cursor = stop;
                }
                div.append(container.ownerDocument.createTextNode(item.str.slice(cursor)));
            }
            offset = end + ('hasEOL' in item && item.hasEOL ? 1 : 0);
        }
    };
    const render = async (slot: Slot) => {
        if (disposed || !slot.visible || slot.active) return;
        const identity = {}; slot.active = identity;
        try {
            const page = slot.pageProxy ?? await input.document.getPage(slot.page);
            if (disposed || slot.active !== identity) return;
            slot.pageProxy = page;
            const viewport = page.getViewport({ scale });
            slot.element.style.width = `${viewport.width}px`; slot.element.style.height = `${viewport.height}px`;
            const size = resolvePdfCanvasSize({ width: viewport.width, height: viewport.height, devicePixelRatio: container.ownerDocument.defaultView?.devicePixelRatio ?? 1 });
            const canvas = container.ownerDocument.createElement('canvas');
            canvas.className = 'pdf-page-canvas'; canvas.width = size.width; canvas.height = size.height;
            canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
            slot.element.append(canvas);
            slot.task = page.render({ canvas, viewport, transform: [size.outputScale, 0, 0, size.outputScale, 0, 0] });
            const painting = slot.task.promise.catch(error => { if (!disposed && slot.active === identity) input.onError?.(error); });
            if (input.createTextLayer) {
                const layer = container.ownerDocument.createElement('div'); layer.className = 'textLayer pdf-text-layer';
                slot.element.append(layer);
                const text = await input.createTextLayer(page, viewport, layer);
                if (disposed || slot.active !== identity) { text.cancel(); return; }
                slot.text = text;
                await text.render();
                if (disposed || slot.active !== identity) return;
                highlight(slot); reveal();
            }
            await painting;
        } catch (error) { if (!disposed && slot.active === identity) input.onError?.(error); }
    };
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const slot = slots.find(candidate => candidate.element === entry.target);
            if (!slot) continue;
            slot.visible = entry.isIntersecting;
            if (slot.visible) void render(slot); else release(slot);
        }
    }, { root: container, rootMargin: '150%' });
    const ready = (async () => {
        if (input.signal?.aborted) return;
        const first = await input.document.getPage(1);
        if (disposed) return;
        const viewport = first.getViewport({ scale });
        for (let page = 1; page <= input.document.numPages; page++) {
            const element = container.ownerDocument.createElement('div'); element.className = 'pdf-page'; element.dataset.pdfPage = String(page);
            element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
            const slot: Slot = { page, element, visible: false, pageProxy: page === 1 ? first : null, active: null, task: null, text: null };
            slots.push(slot); container.append(element); observer.observe(element);
        }
        input.onPagesInit?.(input.document.numPages);
        input.onPagesLoaded?.(input.document.numPages);
    })();
    const pageAt = (top: number) => {
        let low = 0; let high = slots.length;
        while (low < high) { const mid = Math.floor((low + high) / 2); if (slots[mid]!.element.offsetTop <= top) low = mid + 1; else high = mid; }
        return Math.max(1, low);
    };
    const position = (): PdfViewPosition => {
        const page = pageAt(container.scrollTop);
        return { page, top: Math.max(0, container.scrollTop - (slots[page - 1]?.element.offsetTop ?? 0)), left: Math.max(0, container.scrollLeft) };
    };
    for (const event of ['pointerdown', 'wheel', 'touchstart']) container.addEventListener(event, () => input.onReaderMove?.(), { signal: listeners.signal, passive: true });
    let currentPage = 0;
    container.addEventListener('scroll', () => {
        const next = pageAt(container.scrollTop + container.clientHeight / 3);
        if (currentPage !== next) { currentPage = next; input.onPageChange?.(next); }
        input.onLocationChange?.(position());
    }, { signal: listeners.signal });
    const viewer = {
        ready,
        getViewPosition: position,
        restorePosition(position: PdfViewPosition) { const slot = slots[Math.max(0, Math.min(slots.length - 1, position.page - 1))]; if (slot) { container.scrollTop = slot.element.offsetTop + position.top; container.scrollLeft = position.left; } },
        setScale(next: number, anchor = { x: container.clientWidth / 2, y: container.clientHeight / 2 }) {
            if (disposed || next === scale || !Number.isFinite(next) || next <= 0) return;
            const scroll = anchorPdfZoom({ scrollLeft: container.scrollLeft, scrollTop: container.scrollTop, pointerX: anchor.x, pointerY: anchor.y, previousScale: scale, nextScale: next });
            const ratio = next / scale; scale = next;
            for (const slot of slots) {
                release(slot);
                slot.element.style.width = `${parseFloat(slot.element.style.width) * ratio}px`;
                slot.element.style.height = `${parseFloat(slot.element.style.height) * ratio}px`;
                if (slot.visible) void render(slot);
            }
            container.scrollLeft = scroll.left; container.scrollTop = scroll.top;
        },
        setFindMatches(next: readonly PdfFindMatch[], current: PdfFindMatch | null) { matches = next; currentMatch = current; for (const slot of slots) highlight(slot); },
        revealMatch(match: PdfFindMatch) { pendingReveal = match; reveal(); },
        goToPage(page: number) { const slot = slots[Math.max(0, Math.min(slots.length - 1, Math.floor(page) - 1))]; if (slot) container.scrollTop = slot.element.offsetTop; },
        dispose() { if (disposed) return; disposed = true; observer.disconnect(); listeners.abort(); removeWheel(); for (const slot of slots) release(slot); container.replaceChildren(); input.signal?.removeEventListener('abort', viewer.dispose); },
    };
    const removeWheel = attachWheelZoom(container, { isZoomed: () => false, onPan: () => {},
        onZoom: (factor, focal) => {
            const next = scale * factor;
            viewer.setScale(next, { x: focal.x + container.clientWidth / 2, y: focal.y + container.clientHeight / 2 });
            input.onScaleChange?.(next);
        },
    });
    if (input.signal?.aborted) viewer.dispose(); else input.signal?.addEventListener('abort', viewer.dispose, { once: true });
    return viewer;
}
