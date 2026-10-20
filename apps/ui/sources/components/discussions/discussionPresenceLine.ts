import {
    formatSessionPresenceHere,
    formatSessionPresenceTyping,
} from '@/components/sessions/collaboration/sessionPresenceNames';
import type { SessionHumanPresenceViewer } from '@/sync/domains/session/humanPresence/sessionHumanPresenceStore';
import { t } from '@/text';

/**
 * The present tense of one conversation, as the header's one quiet line: "Ana and Ben are here · Ben
 * is typing…". The words are the canonical presence owner's (`sessionPresenceNames`, shared with the
 * Collaboration pane); this only lays them on one line. Retained last-known presence carries no typing
 * claim and says it may be out of date; when the only person here is the one typing, it says just that.
 */
export function formatDiscussionPresenceLine(
    viewers: readonly SessionHumanPresenceViewer[],
    options?: Readonly<{ stale?: boolean }>,
): string {
    if (viewers.length === 0) return '';
    const here = formatSessionPresenceHere(viewers);
    if (options?.stale === true) return `${here} · ${t('session.collaboration.stale')}`;
    const typing = formatSessionPresenceTyping(viewers);
    if (!typing) return here;
    return viewers.length === 1 ? typing : `${here} · ${typing}`;
}
