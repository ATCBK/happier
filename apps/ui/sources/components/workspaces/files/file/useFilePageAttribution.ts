import * as React from 'react';
import { normalizeRepositoryFilePath } from '@happier-dev/protocol/sessions/changes/reconcileWithScmSnapshot';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useDerivedSessionChangeSet } from '@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet';
import { useSessionMessageAuthorshipScope } from '@/components/sessions/transcript/useSessionMessageAuthorshipScope';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveFilePageAttribution } from './filePageModel';
import { selectLatestAttributedFileTurn } from './filePageAttribution';

export function useFilePageAttribution(input: Readonly<{
    address: SessionAddress | null;
    filePath: string;
    workspaceRoot: string | null;
    active: boolean;
}>) {
    const address = input.active ? input.address : null;
    const derived = useDerivedSessionChangeSet(address, input.workspaceRoot);
    const authorship = useSessionMessageAuthorshipScope(address?.sessionId ?? '', address?.serverId);
    const path = normalizeRepositoryFilePath(input.filePath, input.workspaceRoot);
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
    }), [authorship.hasOtherNamedCollaborator, authorship.viewerScope, derived.turnRequestersById, turn]);
}
