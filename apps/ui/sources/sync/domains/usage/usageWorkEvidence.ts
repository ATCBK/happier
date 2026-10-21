import { projectUsageQueryWorkEvidence as projectOpenedUsageQueryWorkEvidence,
    projectSessionUsageWorkEvidence as projectOpenedSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { UsageHowYouWorkDetailInput } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export { selectUsageQueryWorkEvidenceSessionIds } from '@happier-dev/protocol/usage/usageWorkEvidence';
type UsageSession = Pick<Session, 'id' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'agentState' | 'sessionTurns'>
    & Partial<Pick<Session, 'createdAt' | 'origin' | 'manager'>>;

export function projectSessionUsageWorkEvidence(session: UsageSession,
    messages?: Parameters<typeof projectOpenedSessionUsageWorkEvidence>[1],
    coverage?: Parameters<typeof projectOpenedSessionUsageWorkEvidence>[2]) {
    return projectOpenedSessionUsageWorkEvidence({ ...session, metadata: readSessionOwnerMetadataView(session) }, messages, coverage);
}

/** UI admission stays at its captured Account/content owners; projection is shared with CLI. */
export function projectUsageQueryWorkEvidence(input: Omit<Parameters<typeof projectOpenedUsageQueryWorkEvidence>[0], 'sessions'> & Readonly<{
    scope: ServerAccountScope; currentScope: ServerAccountScope | null; isCurrent: boolean;
    sessions: readonly (UsageSession & Pick<Session, 'serverId' | 'encryptionMode' | 'encryptedContentAvailability' | 'access'>)[];
}>): UsageHowYouWorkDetailInput {
    if (!input.isCurrent || !areServerAccountScopesEqual(input.scope, input.currentScope)) return { status: 'unknown' };
    const sessions = input.sessions.filter(session => (!session.serverId || session.serverId === input.scope.serverId)
        && session.access?.capabilities.readTranscript !== false
        && isSessionContentReadable(readSessionContentAvailability(session)));
    return projectOpenedUsageQueryWorkEvidence({ ...input, sessions: sessions.map(session => ({ ...session,
        metadata: readSessionOwnerMetadataView(session) })) });
}
