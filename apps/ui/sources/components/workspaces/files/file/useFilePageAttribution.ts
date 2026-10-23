import * as React from 'react';
import { normalizeRepositoryFilePath } from '@happier-dev/protocol/sessions/changes/reconcileWithScmSnapshot';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { useSessionMessageAuthorshipScope } from '@/components/sessions/transcript/useSessionMessageAuthorshipScope';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveFilePageAttribution } from './filePageModel';
import { selectLatestAttributedFileTurn } from './filePageAttribution';
import { useSessionLiveFileWrites } from '@/sync/domains/session/changes/hooks/useSessionLiveFileWrites';
import { useSessionSelector } from '@/sync/store/hooks';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveTrackPresenceLines } from '@/components/sessions/files/track/TrackPauseSignal';
import { t } from '@/text';

export function useFilePageAttribution(input: Readonly<{
    address: SessionAddress | null;
    filePath: string;
    workspaceRoot: string | null;
    active: boolean;
    content?: string | null;
}>) {
    const address = input.active ? input.address : null;
    const derived = useDerivedSessionChangeSet(address, input.workspaceRoot);
    const authorship = useSessionMessageAuthorshipScope(address?.sessionId ?? '', address?.serverId);
    const path = normalizeRepositoryFilePath(input.filePath, input.workspaceRoot);
    const writes = useSessionLiveFileWrites(address, input.workspaceRoot);
    const write = path ? writes.get(path) : undefined;
    const agentId = useSessionSelector(address?.sessionId ?? '', address?.serverId,
        session => session ? readSessionPresentationAgentId(session) : null);
    const writing = React.useMemo(() => {
        if (!write || !path) return null;
        const agentName = agentId ? resolveAgentCatalogTitle(agentId) : t('newSession.wizardSection.agent');
        const lines = resolveTrackPresenceLines({ path, ...write, agentId, agentName }, input.content);
        return { agentName, line: lines?.startLine ?? null };
    }, [agentId, input.content, path, write]);
    const turn = React.useMemo(() => selectLatestAttributedFileTurn(derived.sessionChangeSet, path), [derived.sessionChangeSet, path]);
    return React.useMemo(() => ({
        ...resolveFilePageAttribution({
            agentName: turn?.provider ? resolveAgentCatalogTitle(turn.provider) : null,
            requesterActor: turn ? derived.turnRequestersById.get(turn.turnId) : null,
            viewerScope: authorship.viewerScope,
            hasOtherNamedCollaborator: authorship.hasOtherNamedCollaborator,
        }),
        turnId: turn?.turnId ?? null,
        updatedAt: turn?.derivedAt ?? null,
        writing,
    }), [authorship.hasOtherNamedCollaborator, authorship.viewerScope, derived.turnRequestersById, turn, writing]);
}
