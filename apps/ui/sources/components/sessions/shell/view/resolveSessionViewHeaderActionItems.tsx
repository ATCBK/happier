
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { getPreferredLanguage, t } from '@/text';
import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';

const EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);
const SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE = new LruMap<string, readonly DropdownMenuItem[]>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function buildCacheKey(input: Readonly<{
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    showAutomations: boolean;
    actionIconColor: string;
}>): string {
    return JSON.stringify([
        getPreferredLanguage(),
        input.shouldShowSubagentsButton ? 1 : 0,
        input.subagentActiveCount,
        input.showAutomations ? 1 : 0,
        input.actionIconColor,
    ]);
}

export function resolveSessionViewHeaderActionItems(input: Readonly<{
    shouldFoldHeaderIconActions: boolean;
    shouldShowSubagentsButton: boolean;
    subagentActiveCount: number;
    showAutomations: boolean;
    actionIconColor: string;
}>): readonly DropdownMenuItem[] {
    if (!input.shouldFoldHeaderIconActions) {
        return EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS;
    }

    const cacheKey = buildCacheKey(input);
    const cached = SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const items: DropdownMenuItem[] = [];
    if (input.shouldShowSubagentsButton) {
        items.push({
            id: 'header.openSubagents',
            title: t('session.openSubagents', { count: input.subagentActiveCount }),
            // Menu rows share one glyph size, so every title starts on the same edge.
            icon: <Icon name="robot" size={ICON_SIZE.sm} color={input.actionIconColor} />,
        });
    }
    // No separate "Runs" entry: the Agents roster is the one list of a Session's runs and agents.
    if (input.showAutomations) {
        items.push({
            id: 'header.openAutomations',
            title: t('session.openAutomations'),
            icon: <Icon name="timer" size={ICON_SIZE.sm} color={input.actionIconColor} />,
        });
    }

    const next = items.length > 0 ? items : EMPTY_SESSION_VIEW_HEADER_ACTION_ITEMS;
    SESSION_VIEW_HEADER_ACTION_ITEMS_CACHE.set(cacheKey, next);
    return next;
}
