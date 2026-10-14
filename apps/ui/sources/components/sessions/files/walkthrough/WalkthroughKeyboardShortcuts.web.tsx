import * as React from 'react';

import { isEditableKeyboardTarget } from '@/components/ui/keyboard/isEditableKeyboardTarget';

export type WalkthroughKeyboardShortcutsProps = Readonly<{
    /** Only while the Walkthrough is on screen and in front. */
    enabled: boolean;
    /** The mounted reading surface; neighboring chat controls retain their own keys. */
    scopeRef: Readonly<{ current: unknown }>;
    onMove: (direction: 1 | -1) => void;
    onToggleReviewed?: () => void;
    onAsk?: () => void;
}>;

function readScopeElement(ref: WalkthroughKeyboardShortcutsProps['scopeRef']): HTMLElement | null {
    const ElementConstructor = globalThis.document?.defaultView?.HTMLElement;
    return ElementConstructor && ref.current instanceof ElementConstructor ? ref.current : null;
}

function isHidden(element: Element): boolean {
    if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
    const ownerWindow = element.ownerDocument.defaultView;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = ownerWindow?.getComputedStyle(ancestor);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return true;
    }
    return false;
}

/**
 * The Walkthrough's keys (lab WT1-A): J / K next and previous stop, immediately; R the person's explicit
 * reviewed toggle on the current stop; / asks about it. Never while typing, composing or with a modifier.
 */
export function WalkthroughKeyboardShortcuts(props: WalkthroughKeyboardShortcutsProps) {
    const latest = React.useRef(props);
    latest.current = props;
    React.useEffect(() => {
        if (!props.enabled) return;
        const w = (globalThis as { window?: Window }).window;
        if (!w || typeof w.addEventListener !== 'function') return;
        const engage = (event: Event) => {
            const current = latest.current;
            if (!current.enabled) return;
            const scope = readScopeElement(current.scopeRef);
            const target = event.target;
            if (!scope || isHidden(scope) || !(target instanceof scope.ownerDocument.defaultView!.Element)
                || !scope.contains(target) || isEditableKeyboardTarget(target)) return;
            // Native buttons, links and fields keep their focus. Plain reading content
            // transfers focus from the chat composer without moving the reading scroll.
            if (target.closest('button, a[href], [role="button"], [tabindex]:not([tabindex="-1"])')) return;
            scope.focus({ preventScroll: true });
        };
        const handler = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing === true) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const current = latest.current;
            if (!current.enabled) return;
            const scope = readScopeElement(current.scopeRef);
            if (!scope || isHidden(scope)) return;
            const target = event.target;
            if (!(target instanceof scope.ownerDocument.defaultView!.Element)) return;
            const hiddenComposer = target === scope.ownerDocument.activeElement
                && isEditableKeyboardTarget(target) && isHidden(target);
            if (!hiddenComposer && (!scope.contains(target) || isEditableKeyboardTarget(target))) return;
            const key = event.key.toLowerCase();
            const action = key === 'j' || key === 'k' ? () => current.onMove(key === 'j' ? 1 : -1)
                : key === 'r' ? current.onToggleReviewed : event.key === '/' ? current.onAsk : undefined;
            if (!action) return;
            if (hiddenComposer) scope.focus({ preventScroll: true });
            event.preventDefault();
            event.stopPropagation();
            action();
        };
        // Capture lets a maximized reading surface recover from a retained hidden
        // composer before that input's own keyboard listener receives the key.
        w.addEventListener('keydown', handler, true);
        w.addEventListener('pointerdown', engage, true);
        return () => {
            w.removeEventListener('keydown', handler, true);
            w.removeEventListener('pointerdown', engage, true);
        };
    }, [props.enabled]);
    return null;
}
