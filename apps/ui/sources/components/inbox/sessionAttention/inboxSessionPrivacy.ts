import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';

import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, readLockedSessionName } from '@/utils/sessions/sessionUtils';

/**
 * Whether the Inbox may show this Session only as a status: its content cannot be read on this
 * device. Titles, paths and requests stay hidden then (S0-D privacy). The viewer projection's
 * `status_only` is the Home's notification-preview ceiling, not a statement about this device, so
 * it governs off-app surfaces only.
 */
export function isInboxSessionStatusOnly(session: Session, nowMs: number = Date.now()): boolean {
    return !isSessionAwarenessContentReadableV1(projectUiSessionAwareness(session, nowMs).encryption);
}

/** The one Inbox name for a Session: its title, or the locked name when only its status may show. */
export function readInboxSessionTitle(session: Session, serverId: string | null, nowMs: number = Date.now()): string {
    return isInboxSessionStatusOnly(session, nowMs) ? readLockedSessionName() : getSessionName(session, serverId);
}
