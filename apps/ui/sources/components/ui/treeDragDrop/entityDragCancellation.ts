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
    const pointerDown = () => { suppressPointerActivation = false; };
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
    const keydown = (event: Event) => {
        if ('key' in event && event.key === 'Escape' && runtime.getSnapshot().phase === 'carrying') {
            event.preventDefault();
            finishDrag();
            runtime.cancel('escape');
        }
    };
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
    events.addEventListener('keydown', keydown);
    events.addEventListener('pointerleave', leave);
    return () => {
        stopPointer();
        stopCarry();
        events.removeEventListener('pointerdown', pointerDown, true);
        events.removeEventListener('click', click, true);
        for (const name of cancellationEvents) events.removeEventListener(name, cancel);
        events.removeEventListener('dragstart', startDrag, true);
        events.removeEventListener('drop', finishDrag, true);
        events.removeEventListener('dragend', finishDrag, true);
        events.removeEventListener('keydown', keydown);
        events.removeEventListener('pointerleave', leave);
        runtime.cancel('realm-unmount');
    };
}
