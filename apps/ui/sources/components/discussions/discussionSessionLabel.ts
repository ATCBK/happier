import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { isUntitledSessionName } from '@/utils/sessions/sessionUtils';

/**
 * A Session as a Discussion names it (an answer's byline, a mention, a hold, who is waiting): its title, or for
 * an untitled one its Agent, never the generic untitled word that every untitled answer would share.
 */
export function discussionSessionLabel(source: SessionDisplayNameSource | null): string | null {
    const title = sessionDisplayTitle(source);
    if (!source || title === null || !(isUntitledSessionName(title) || title === t('session.folderless.untitledChat'))) return title;
    const agentId = readSessionPresentationAgentId(source);
    return agentId ? resolveAgentCatalogTitle(agentId) : title;
}

/**
 * Who a waiting line names: the Session's own title or its Agent, never the generic untitled word, which would
 * name no one ("Untitled session needs approval"). Null keeps the generic line.
 */
export function discussionWaitingSessionName(source: SessionDisplayNameSource | null): string | null {
    const label = discussionSessionLabel(source);
    return label === null || isUntitledSessionName(label) || label === t('session.folderless.untitledChat') ? null : label;
}
