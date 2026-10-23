import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, readLockedSessionName } from '@/utils/sessions/sessionUtils';

/**
 * Whether the Inbox may show this Session only as a status: its content cannot be read on this
 * device. Titles, paths and requests stay hidden then (S0-D privacy). The viewer projection's
 * `status_only` is the Home's notification-preview ceiling, not a statement about this device, so
 * it governs off-app surfaces only.
 */
export function isInboxSessionStatusOnly(session: Session): boolean {
    // Content visibility is already settled by decryption, independently of runtime/pending state.
    return !isSessionContentReadable(readSessionContentAvailability(session));
}

/** The one Inbox name for a Session: its title, or the locked name when only its status may show. */
export function readInboxSessionTitle(session: Session, serverId: string | null): string {
    return isInboxSessionStatusOnly(session) ? readLockedSessionName() : getSessionName(session, serverId);
}
