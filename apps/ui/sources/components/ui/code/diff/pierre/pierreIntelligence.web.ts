import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesViewCore';
import { readCodeTextPointer } from '@/components/ui/code/interactions/codeTextDom';
import { readPierreDomLine } from './pierreDomLine';
import { registerPierreTextHighlights } from './pierreFindHighlights.web';

/** Presentation supplies ::highlight rules inside Pierre's existing unsafeCSS adapter. */
export const PIERRE_DIAGNOSTIC_HIGHLIGHT_NAMES = {
    error: 'happier-diagnostic-error',
    warning: 'happier-diagnostic-warning',
    information: 'happier-diagnostic-information',
    hint: 'happier-diagnostic-hint',
} as const;

/** P6's shadow-root metadata -> P7's existing read-view callbacks; no provider or identifier policy. */
export function bindPierreIntelligence(
    root: HTMLElement | ShadowRoot,
    byNewLine: ReadonlyMap<number, CodeLine>,
    intelligence: NonNullable<CodeLinesViewProps['intelligence']>,
    rangeSelectionEnabled: boolean,
): () => void {
    const resolve = (event: MouseEvent) => {
        const content = event.target instanceof Element ? event.target.closest('[data-line][data-line-type]') : null;
        if (!content || !root.contains(content)) return null;
        const newLine = readPierreDomLine(content)?.newLine;
        if (newLine == null) return null;
        const line = byNewLine.get(newLine);
        const pointer = line ? readCodeTextPointer(content, event.clientX, event.clientY) : null;
        return line && pointer ? { lineId: line.id, newLine, ...pointer, offset16: Math.min(line.renderCodeText.length, pointer.offset16) } : null;
    };
    const move = (event: Event) => {
        if ((event as PointerEvent).pointerType === 'touch') return;
        const pointer = resolve(event as MouseEvent);
        if (pointer) intelligence.onPointerToken(pointer.lineId, pointer.offset16, pointer.rect, pointer.newLine);
        else intelligence.onPointerAway?.();
    };
    const click = (event: Event) => {
        const mouse = event as MouseEvent;
        if (mouse.button !== 0 || !(mouse.metaKey || mouse.ctrlKey)) return;
        const pointer = resolve(mouse);
        if (!pointer) return;
        event.preventDefault();
        event.stopPropagation();
        intelligence.onActivateToken(pointer.lineId, pointer.offset16, { via: 'modifier', rect: pointer.rect }, pointer.newLine);
    };
    const touch = (event: Event) => {
        if ((event as PointerEvent).pointerType !== 'touch' || rangeSelectionEnabled) return;
        if (root.ownerDocument.getSelection()?.isCollapsed === false) return;
        const pointer = resolve(event as PointerEvent);
        if (pointer) intelligence.onActivateToken(pointer.lineId, pointer.offset16, { via: 'touch', rect: pointer.rect }, pointer.newLine);
    };
    const leave = (event: Event) => {
        const next = (event as PointerEvent).relatedTarget;
        if (!(next instanceof Node) || !root.contains(next)) intelligence.onPointerAway?.();
    };
    root.addEventListener('pointermove', move, true);
    root.addEventListener('click', click, true);
    root.addEventListener('pointerup', touch, true);
    root.addEventListener('pointerout', leave, true);
    const ranges = [];
    for (const content of root.querySelectorAll('[data-line][data-line-type]')) {
        const newLine = readPierreDomLine(content)?.newLine;
        if (newLine == null) continue;
        for (const diagnostic of intelligence.diagnosticsByNewLine?.get(newLine) ?? []) {
            ranges.push({ content, ...diagnostic, name: PIERRE_DIAGNOSTIC_HIGHLIGHT_NAMES[diagnostic.severity] });
        }
    }
    const stopHighlights = registerPierreTextHighlights(ranges);
    return () => {
        root.removeEventListener('pointermove', move, true);
        root.removeEventListener('click', click, true);
        root.removeEventListener('pointerup', touch, true);
        root.removeEventListener('pointerout', leave, true);
        stopHighlights();
        // A repaint replaces this binding without moving the pointer. Only native departure events
        // (or a move outside code) report pointer-away; the page controller owns its final disposal.
    };
}
