import * as React from 'react';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { KeyboardShortcutDisposition, KeyboardShortcutHandlers } from '@/keyboard/runtime';
import { ESCAPE_LAYER_PRIORITIES, getMaxEscapeKeyBlockerPriority, useEscapeLayer } from '@/keyboard/escape';
import { createInboxItemRoute, resolveInboxItemPageRoute, type InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { advanceResolvedInboxItem, moveInboxItem } from '@/components/inbox/inboxItemNavigation';
import { selectInboxItemsForView, type InboxItem, type InboxItemView } from '@/components/inbox/inboxItems';

function selectionKey(focus: InboxItemFocus | null): string | null {
    return focus ? createInboxItemRoute(focus).params.item : null;
}

/** URL selection, mail keys and Needs-you-only advancement; source owners keep every lifecycle. */
export function useInboxItemNavigation(options: Readonly<{
    items: readonly InboxItem[];
    view: InboxItemView;
    focus: InboxItemFocus | null;
    /** A current owning record confirms the selected item has been answered. Missing rows do not. */
    selectedResolved: boolean;
    enabled: boolean;
    select: (focus: InboxItemFocus) => void;
    open: (route: string) => void;
    close: () => void;
    markOpened: (item: InboxItem) => Promise<void>;
}>): void {
    const current = React.useRef(options);
    current.current = options;
    const visibleItems = React.useMemo(() => selectInboxItemsForView(options.items, options.view), [options.items, options.view]);
    const selected = options.items.find(item => selectionKey(item.focus) === selectionKey(options.focus));
    const previous = React.useRef({ items: visibleItems, view: options.view, focus: selectionKey(options.focus), selectedKey: selected?.key });
    React.useEffect(() => {
        const before = previous.current;
        const sameSelection = before.view === options.view && before.focus === selectionKey(options.focus);
        const resolved = options.selectedResolved;
        if (options.enabled && sameSelection && before.selectedKey && resolved) {
            const next = advanceResolvedInboxItem(options.view, before.items, visibleItems, before.selectedKey);
            if (next) options.select(next.focus);
        }
        // A missing projection is not an answer. Keep the existing navigation anchor until
        // the same owning record resolves, the row returns, or the person changes selection.
        if (sameSelection && before.selectedKey && !selected && !resolved) return;
        previous.current = { items: visibleItems, view: options.view, focus: selectionKey(options.focus), selectedKey: selected?.key };
    }, [options.enabled, options.focus, options.select, options.selectedResolved, options.view, selected?.key, selected?.view, visibleItems]);

    // Selection is a real read intent only in the two informational views. Answering remains at the request owner.
    React.useEffect(() => {
        if (options.enabled && selected && selected.view === options.view && selected.view !== 'needs_you' && !selected.read) void options.markOpened(selected);
    }, [options.enabled, options.markOpened, options.view, selected]);

    const navigate = React.useCallback((direction: -1 | 1): KeyboardShortcutDisposition => {
        const active = current.current;
        if (!active.enabled || getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.pane) return 'pass';
        const items = selectInboxItemsForView(active.items, active.view);
        const focused = items.find(item => selectionKey(item.focus) === selectionKey(active.focus));
        const next = moveInboxItem(items, focused?.key ?? null, direction);
        if (!next) return 'pass';
        active.select(next.focus);
        return 'handled';
    }, []);
    const open = React.useCallback((): KeyboardShortcutDisposition => {
        const active = current.current;
        if (!active.enabled || getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.pane) return 'pass';
        const focused = active.items.find(item => item.view === active.view && selectionKey(item.focus) === selectionKey(active.focus));
        if (!focused) return 'pass';
        active.open(active.focus?.kind === 'session' ? resolveInboxItemPageRoute(active.focus) : focused.pageRoute);
        return 'handled';
    }, []);
    const handlers = React.useMemo<KeyboardShortcutHandlers>(() => options.enabled ? {
        'inbox.item.next': () => navigate(1), 'inbox.item.previous': () => navigate(-1), 'inbox.item.open': open,
        'inbox.item.close': () => {
            const active = current.current;
            if (!active.focus || getMaxEscapeKeyBlockerPriority() > ESCAPE_LAYER_PRIORITIES.pane) return 'pass';
            active.close();
            return 'handled';
        },
    } : {}, [navigate, open, options.enabled]);
    useKeyboardShortcutHandlers(handlers);
    useEscapeLayer({ priority: ESCAPE_LAYER_PRIORITIES.pane, enabled: options.enabled && options.focus !== null,
        onEscape: () => { current.current.close(); } });
}
