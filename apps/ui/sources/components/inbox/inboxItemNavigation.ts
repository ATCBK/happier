import type { InboxItem, InboxItemView } from './inboxItems';

type NavigationItem = Pick<InboxItem, 'key' | 'focus' | 'view'>;

export function moveInboxItem(
    items: readonly NavigationItem[], selectedKey: string | null, direction: -1 | 1,
): NavigationItem | null {
    if (items.length === 0) return null;
    const index = items.findIndex(item => item.key === selectedKey);
    if (index < 0) return direction === 1 ? items[0]! : items[items.length - 1]!;
    return items[Math.max(0, Math.min(items.length - 1, index + direction))]!;
}

/** Only an item removed from Needs you may move selection without another user intent. */
export function advanceResolvedInboxItem(
    view: InboxItemView, previous: readonly NavigationItem[], current: readonly NavigationItem[], selectedKey: string,
): NavigationItem | null {
    if (view !== 'needs_you' || current.some(item => item.key === selectedKey)) return null;
    const index = previous.findIndex(item => item.key === selectedKey);
    if (index < 0) return null;
    const survivors = new Map(current.filter(item => item.view === 'needs_you').map(item => [item.key, item]));
    for (const item of previous.slice(index + 1)) {
        const next = survivors.get(item.key);
        if (next) return next;
    }
    for (const item of previous.slice(0, index).reverse()) {
        const next = survivors.get(item.key);
        if (next) return next;
    }
    return null;
}
