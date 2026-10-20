export type PdfViewPosition = Readonly<{ page: number; top: number; left: number }>;
export function createPdfViewPosition(input: Readonly<{ initial: PdfViewPosition | null; restore(position: PdfViewPosition): void; persist(position: PdfViewPosition): void }>) {
    let pageCount = 1;
    let armed = false;
    let moved = false;
    let latest: PdfViewPosition | null = null;
    let disposed = false;
    const clamp = (position: PdfViewPosition): PdfViewPosition => ({
        page: Math.max(1, Math.min(pageCount, position.page)), top: Math.max(0, position.top), left: Math.max(0, position.left),
    });
    const restore = () => { if (!disposed && !moved && input.initial) input.restore(clamp(input.initial)); };
    return {
        pagesInit(count: number) { pageCount = count; restore(); },
        pagesLoaded(count: number) { pageCount = count; restore(); armed = true; },
        readerMoved() { moved = true; armed = true; },
        locationChanged(position: PdfViewPosition) { if (!disposed && armed) { latest = clamp(position); return latest; } return null; },
        dispose() { if (disposed) return; disposed = true; if (latest) input.persist(latest); },
    };
}
