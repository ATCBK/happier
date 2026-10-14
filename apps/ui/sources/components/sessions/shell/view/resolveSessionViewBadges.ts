import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

const SESSION_VIEW_BADGES_CACHE = new LruMap<string, ReadonlyArray<string>>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

const NO_BADGES: ReadonlyArray<string> = Object.freeze([]);

export function resolveSessionViewBadges(input: Readonly<{
    storageBadge: string | null;
    providerBadge: string | null;
}>): ReadonlyArray<string> {
    if (!input.storageBadge && !input.providerBadge) {
        return NO_BADGES;
    }
    const cacheKey = [input.storageBadge ?? '', input.providerBadge ?? ''].join('|');
    const cached = SESSION_VIEW_BADGES_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const next = [input.storageBadge, input.providerBadge].filter((badge): badge is string => Boolean(badge));
    SESSION_VIEW_BADGES_CACHE.set(cacheKey, next);
    return next;
}
