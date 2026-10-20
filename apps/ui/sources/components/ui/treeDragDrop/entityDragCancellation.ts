import { dispatchEscapeToLayerStack, ESCAPE_LAYER_PRIORITIES, registerEscapeLayer } from '@/keyboard/escape';
import type { EntityDragDropRuntime } from './entityDragDropTypes';

/** One realm-owned event boundary, installed by the shared feedback host. */
export function installEntityDragCancellation(runtime: EntityDragDropRuntime, events: EventTarget): () => void {
    // A threshold-crossing pointer carry has already consumed this press. Keep that fact
    // across pending/settled/cancelled feedback until the browser's release click or a new
    // deliberate pointer-down. Keyboard activation and subsequent presses stay independent.
    let suppressPointerActivation = false;
    const observePointerCarry = () => {
        if (runtime.getSnapshot().phase === 'carrying' && runtime.getPointer() !== null) {
            suppressPointerActivation = true;
        }
    };
    const stopPointer = runtime.subscribePointer(observePointerCarry);
    const stopCarry = runtime.subscribe(observePointerCarry);
    // A refused release returns the carried card to its source; the next press ends that return even if
    // its animation never reports completion (a stalled frame loop must not pin the card).
    const returning = () => {
        const snapshot = runtime.getSnapshot();
        return snapshot.phase === 'settled' && snapshot.outcome?.status === 'refused' && runtime.getPointer() !== null;
    };
    const pointerDown = () => {
        suppressPointerActivation = false;
        if (returning()) runtime.cancel('pointerdown');
    };
    const click = (event: Event) => {
        if (!suppressPointerActivation || !('detail' in event) || event.detail === 0) return;
        suppressPointerActivation = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    events.addEventListener('pointerdown', pointerDown, true);
    events.addEventListener('click', click, true);
    // HTML drag delivery retires the pointer stream after dragstart. Its carry lives until
    // drop/dragend, Escape or blur; pointercancel/lostcapture are not gesture cancellation.
    let htmlDragStart: Event | null = null;
    const startDrag = (event: Event) => { htmlDragStart = event; };
    const finishDrag = () => { htmlDragStart = null; };
    const cancel = (event: Event) => {
        if (htmlDragStart && !htmlDragStart.defaultPrevented
            && (event.type === 'pointercancel' || event.type === 'lostpointercapture')) return;
        finishDrag();
        runtime.cancel(event.type);
    };
    // Escape belongs to the carry only while its feedback is on screen (carried, dispatched and awaiting its
    // owner, or returning after a refusal), and ahead of every surface the list sits in: the first Escape
    // cancels the move or retires the feedback, the next one closes the popover or modal around it.
    let releaseEscape: (() => void) | null = null;
    const syncEscape = () => {
        const phase = runtime.getSnapshot().phase;
        const carrying = phase === 'carrying' || phase === 'pending' || returning();
        if (carrying === (releaseEscape !== null)) return;
        if (!carrying) { releaseEscape?.(); releaseEscape = null; return; }
        const unregister = registerEscapeLayer({
            priority: ESCAPE_LAYER_PRIORITIES.entityCarry,
            allowEditableTarget: true,
            onEscape: () => { finishDrag(); runtime.cancel('escape'); return true; },
        });
        const dispatch = (event: Event) => { dispatchEscapeToLayerStack(event); };
        events.addEventListener('keydown', dispatch, true);
        releaseEscape = () => { events.removeEventListener('keydown', dispatch, true); unregister(); };
    };
    const stopEscape = runtime.subscribe(syncEscape);
    syncEscape();
    const leave = (event: Event) => {
        if ('relatedTarget' in event && event.relatedTarget == null) {
            finishDrag();
            runtime.cancel('window-leave');
        }
    };
    const cancellationEvents = ['blur', 'pointercancel', 'lostpointercapture', 'dragend'];
    for (const name of cancellationEvents) events.addEventListener(name, cancel);
    events.addEventListener('dragstart', startDrag, true);
    events.addEventListener('drop', finishDrag, true);
    events.addEventListener('dragend', finishDrag, true);
    events.addEventListener('pointerleave', leave);
    return () => {
        stopPointer();
        stopCarry();
        stopEscape();
        releaseEscape?.();
        releaseEscape = null;
        events.removeEventListener('pointerdown', pointerDown, true);
        events.removeEventListener('click', click, true);
        for (const name of cancellationEvents) events.removeEventListener(name, cancel);
        events.removeEventListener('dragstart', startDrag, true);
        events.removeEventListener('drop', finishDrag, true);
        events.removeEventListener('dragend', finishDrag, true);
        events.removeEventListener('pointerleave', leave);
        runtime.cancel('realm-unmount');
    };
}
