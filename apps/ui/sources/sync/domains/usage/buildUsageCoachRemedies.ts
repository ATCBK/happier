import { buildUsageCoachRemedies as buildOpenedUsageCoachRemedies } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export function buildUsageCoachRemedies(input: Omit<Parameters<typeof buildOpenedUsageCoachRemedies>[0], 'sessions'> & Readonly<{
    sessions: readonly Pick<Session, 'id' | 'serverId' | 'active' | 'access' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'>[];
}>) {
    return buildOpenedUsageCoachRemedies({ ...input, sessions: input.sessions.map(session => ({
        id: session.id, serverId: session.serverId, active: session.active,
        access: session.access ?? undefined,
        // The canonical remedy builder selects and admits its target first.
        // Only that target needs stored metadata and Agent-target resolution.
        get ownerMetadata() { return readSessionOwnerMetadataView(session); },
        get agentTarget() { return resolveSessionActionDefaultBackend({ session })?.agentTarget ?? null; },
    })) });
}
