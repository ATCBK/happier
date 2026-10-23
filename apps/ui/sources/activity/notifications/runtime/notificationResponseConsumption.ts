import type { ParsedNotificationTap } from '../notificationRouting';

// Shared by headless handling and foreground navigation. This runtime-only set
// records delivered events for presentation; it never admits or rejects a send.
const handledResponses = new Set<string>();

function responseKey(parsed: ParsedNotificationTap): string | null {
    const permission = parsed.permissionAction;
    const identity = parsed.dedupeKey ?? (permission?.occurrenceId
        ? JSON.stringify([permission.sessionId, permission.requestId, permission.occurrenceId])
        : null);
    return identity ? JSON.stringify([
        parsed.serverUrl, parsed.accountId ?? null, identity, parsed.route,
        permission?.sessionId, permission?.requestId, permission?.occurrenceId,
    ]) : null;
}

export function wasNotificationResponseHandled(parsed: ParsedNotificationTap): boolean {
    const key = responseKey(parsed);
    return key !== null && handledResponses.has(key);
}

export function markNotificationResponseHandled(parsed: ParsedNotificationTap): void {
    const key = responseKey(parsed);
    if (key !== null) handledResponses.add(key);
}
