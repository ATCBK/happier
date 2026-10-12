const CONCURRENT_SESSION_CACHE_REFRESH_UPDATE_TYPES = new Set([
    'account-change',
    'new-session',
    'delete-session',
    'pending-changed',
    'update-session',
    'new-message',
    'message-updated',
]);

const CONCURRENT_MACHINE_CACHE_REFRESH_UPDATE_TYPES = new Set([
    'new-machine',
    'update-machine',
]);

export type ConcurrentSessionCacheUpdateImpact = 'machines' | 'snapshot' | null;

function readConcurrentUpdateType(raw: unknown): string | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const body = (raw as { body?: unknown }).body;
    if (!body || typeof body !== 'object') {
        return null;
    }

    const updateType = (body as { t?: unknown }).t;
    return typeof updateType === 'string' ? updateType : null;
}

export function shouldRefreshConcurrentSessionCacheForUpdate(raw: unknown): boolean {
    return classifyConcurrentSessionCacheUpdate(raw) !== null;
}

export function classifyConcurrentSessionCacheUpdate(raw: unknown): ConcurrentSessionCacheUpdateImpact {
    const updateType = readConcurrentUpdateType(raw);
    if (updateType !== null && CONCURRENT_MACHINE_CACHE_REFRESH_UPDATE_TYPES.has(updateType)) return 'machines';
    return updateType !== null && CONCURRENT_SESSION_CACHE_REFRESH_UPDATE_TYPES.has(updateType) ? 'snapshot' : null;
}

export function isAccountChangeUpdate(raw: unknown): boolean {
    const type = readConcurrentUpdateType(raw);
    return type === 'update-account' || type === 'account-change';
}
