import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

/**
 * Who another Session is, as a transcript names it: its title and its agent mark. One owner for every
 * row that points at another Session (a returned answer, an Ask record's targets), qualified by the
 * transcript's own Home like the provenance label.
 */
export function useTranscriptSessionIdentity(sessionId: string | null, serverId: string | null) {
  const session = useSessionDisplayNameSource(sessionId ?? '', serverId);
  return {
    name: session ? getSessionName(session, serverId) : t('message.provenanceSession'),
    agentId: resolveAgentIdFromFlavor(session ? readSessionOwnerMetadataView(session)?.flavor ?? null : null),
  };
}
