import type { editor } from 'monaco-editor';
import type { CodeEditorHandle, Rect } from '../codeEditorTypes';

type PeekZone = NonNullable<Parameters<NonNullable<CodeEditorHandle['setPeekZone']>>[0]>;

/**
 * The change peek's room as one Monaco view zone (ade-shell ED3 E1): the host draws the peek over it, so the
 * lines below move down instead of being covered. Monaco owns the zone's position through scrolling and edits.
 */
export function createMonacoPeekZone(engine: editor.IStandaloneCodeEditor, onMoved: () => void):
    Required<Pick<CodeEditorHandle, 'setPeekZone' | 'getPeekZoneRect'>> & Readonly<{ dispose: () => void }> {
    let current: Readonly<{ id: string; requested: PeekZone; afterLine: number; height: number; spec: editor.IViewZone }> | null = null;
    // Where a room after `line` starts: the bottom of that line, never counting the room itself.
    const zoneTop = (line: number) => line >= 1 ? engine.getBottomForLineNumber(line) : engine.getTopForLineNumber(1, true);
    const remove = () => {
        const id = current?.id;
        current = null;
        if (id) engine.changeViewZones((accessor) => accessor.removeZone(id));
    };
    /** A change taller than the editor peeks under the last of its lines in view, not where its end is. */
    const placeAfter = (zone: PeekZone, height: number): number => {
        const first = Math.max(1, Math.floor(zone.firstLine ?? zone.afterLine));
        if (zone.afterLine < first) return zone.afterLine;
        const viewport = engine.getLayoutInfo().height;
        if (zoneTop(zone.afterLine) + height - engine.getTopForLineNumber(first) <= viewport) return zone.afterLine;
        const limit = engine.getScrollTop() + viewport - height;
        let low = first;
        let high = zone.afterLine;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (zoneTop(middle) <= limit) low = middle;
            else high = middle - 1;
        }
        return low;
    };
    const setPeekZone: CodeEditorHandle['setPeekZone'] = (requested) => {
        if (!engine.changeViewZones) return;
        if (!requested) { if (current) { remove(); onMoved(); } return; }
        const height = Math.max(0, Math.round(requested.height));
        const afterLine = Math.max(0, Math.floor(requested.afterLine));
        const zone = { ...requested, afterLine };
        if (current && current.requested.afterLine === zone.afterLine && current.requested.firstLine === zone.firstLine) {
            if (current.height === height) return;
            const { id, spec } = current;
            spec.heightInPx = height;
            current = { ...current, requested: zone, height };
            engine.changeViewZones((accessor) => accessor.layoutZone(id));
        } else {
            remove();
            const placed = placeAfter(zone, height);
            const spec: editor.IViewZone = { afterLineNumber: placed, heightInPx: height, domNode: document.createElement('div') };
            let id = '';
            engine.changeViewZones((accessor) => { id = accessor.addZone(spec); });
            current = { id, requested: zone, afterLine: placed, height, spec };
            // The change reads from its first column even when the editor was scrolled sideways.
            engine.setScrollLeft(0);
        }
        const viewport = engine.getLayoutInfo().height;
        const bottom = zoneTop(current.afterLine) + height;
        if (bottom - engine.getScrollTop() > viewport) engine.setScrollTop(Math.max(0, bottom - viewport));
        onMoved();
    };
    const getPeekZoneRect = (): Rect | null => {
        if (!current) return null;
        const bounds = engine.getDomNode()?.getBoundingClientRect();
        if (!bounds) return null;
        const layout = engine.getLayoutInfo();
        return { x: bounds.left + layout.contentLeft, y: bounds.top + zoneTop(current.afterLine) - engine.getScrollTop(), width: layout.contentWidth, height: current.height };
    };
    return { setPeekZone, getPeekZoneRect, dispose: remove };
}
