export type PdfViewPosition = Readonly<{ page: number; top: number; left: number }>;
const sameAs = (a: PdfViewPosition | null, b: PdfViewPosition) => a !== null && a.page === b.page && a.top === b.top && a.left === b.left;
/**
 * One viewer's part in its tab's PDF place (P3 view memory): it restores the tab's place once the pages
 * exist, writes each settled location back as it changes, so every other viewer of the same tab (the
 * phone page mounted beside a desktop one) opens there, and follows a place another viewer wrote.
 */
export function createPdfViewPosition(input: Readonly<{ initial: PdfViewPosition | null; restore(position: PdfViewPosition): void; persist(position: PdfViewPosition): void }>) {
    let pageCount = 1;
    let armed = false;
    let moved = false;
    let latest: PdfViewPosition | null = null;
    // The tab's place as this viewer last knew it, written or read: neither an echo nor a repeat writes again.
    let initial = input.initial;
    let known: PdfViewPosition | null = initial;
    let disposed = false;
    const clamp = (position: PdfViewPosition): PdfViewPosition => ({
        page: Math.max(1, Math.min(pageCount, position.page)), top: Math.max(0, position.top), left: Math.max(0, position.left),
    });
    const write = (position: PdfViewPosition) => { if (sameAs(known, position)) return; known = position; input.persist(position); };
    const restore = () => { if (!disposed && !moved && initial) input.restore(clamp(initial)); };
    return {
        pagesInit(count: number) { pageCount = count; restore(); },
        pagesLoaded(count: number) { pageCount = count; restore(); armed = true; },
        readerMoved() { moved = true; armed = true; },
        locationChanged(position: PdfViewPosition) { if (!disposed && armed) { latest = clamp(position); write(latest); return latest; } return null; },
        adopt(position: PdfViewPosition) {
            if (disposed || sameAs(known, position)) return;
            known = position; latest = null;
            // Before the pages exist the place waits as the one to restore; after, it moves the reader there.
            if (!armed) { initial = position; return; }
            input.restore(clamp(position));
        },
        dispose() { if (disposed) return; disposed = true; if (latest) write(latest); },
    };
}
