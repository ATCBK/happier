import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesViewCore';
import { readCodeTextPointer } from '@/components/ui/code/interactions/codeTextDom';
import { resolveCodeTokenPress, type CodeTokenPointer } from '@/components/ui/code/interactions/codeTokenPress';
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
    gesture: { pointer: CodeTokenPointer | null; cancelled: boolean },
    rangeSelectionActive = false,
): Readonly<{ onClick: (event: MouseEvent) => boolean; dispose: () => void }> {
    const resolve = (event: MouseEvent) => {
        // The wrapper captures before Pierre's line click. Shadow DOM retargets event.target to its host.
        const target = event.composedPath().find(node => node instanceof Element && root.contains(node));
        const content = target instanceof Element ? target.closest('[data-line][data-line-type]') : null;
        if (!content || !root.contains(content)) return null;
        const newLine = readPierreDomLine(content)?.newLine;
        if (newLine == null) return null;
        const line = byNewLine.get(newLine);
        const pointer = line?.renderCodeText.trim() ? readCodeTextPointer(content, event.clientX, event.clientY) : null;
        return line && pointer ? { lineId: line.id, newLine, ...pointer, offset16: Math.min(line.renderCodeText.length, pointer.offset16) } : null;
    };
    const move = (event: Event) => {
        if ((event as PointerEvent).pointerType === 'touch') return;
        const pointer = resolve(event as MouseEvent);
        if (pointer) intelligence.onPointerToken(pointer.lineId, pointer.offset16, pointer.rect, pointer.newLine);
        else intelligence.onPointerAway?.();
    };
    const click = (event: MouseEvent): boolean => {
        const touch = gesture.pointer;
        gesture.pointer = null;
        const via = resolveCodeTokenPress(event, touch !== null, rangeSelectionActive || root.ownerDocument.getSelection()?.isCollapsed === false);
        if (!via) return false;
        const pointer = via === 'touch' ? touch : resolve(event);
        if (!pointer) return false;
        if (intelligence.onActivateToken(pointer.lineId, pointer.offset16, { via, rect: pointer.rect }, pointer.newLine) !== true) return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
    };
    const start = () => { gesture.pointer = null; gesture.cancelled = false; };
    const cancel = () => { gesture.pointer = null; gesture.cancelled = true; };
    const touch = (event: Event) => {
        gesture.pointer = null;
        if ((event as PointerEvent).pointerType !== 'touch' || gesture.cancelled) return;
        if (root.ownerDocument.getSelection()?.isCollapsed === false) return;
        gesture.pointer = resolve(event as PointerEvent);
    };
    const leave = (event: Event) => {
        if ((event as PointerEvent).pointerType === 'touch') return;
        const next = (event as PointerEvent).relatedTarget;
        if (!(next instanceof Node) || !root.contains(next)) intelligence.onPointerAway?.();
    };
    root.addEventListener('pointermove', move, true);
    root.addEventListener('pointerdown', start, true);
    root.addEventListener('pointercancel', cancel, true);
    root.addEventListener('contextmenu', cancel, true);
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
    return { onClick: click, dispose: () => {
        root.removeEventListener('pointermove', move, true);
        root.removeEventListener('pointerdown', start, true);
        root.removeEventListener('pointercancel', cancel, true);
        root.removeEventListener('contextmenu', cancel, true);
        root.removeEventListener('pointerup', touch, true);
        root.removeEventListener('pointerout', leave, true);
        stopHighlights();
        // A repaint replaces this binding without moving the pointer. Only native departure events
        // (or a move outside code) report pointer-away; the page controller owns its final disposal.
    } };
}
