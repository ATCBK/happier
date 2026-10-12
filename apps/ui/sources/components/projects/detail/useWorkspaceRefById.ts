import { useProjectAccountRows, useWorkspaceRefs } from '@/sync/domains/state/storage';
import * as React from 'react';

import type { WorkspaceRefResolutionV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { isProjectAccountRowsCensusComplete, type ProjectAccountRowsStatus } from '@/sync/store/domains/projectAccountRows';

/**
 * A checkout the opened census does not list yet, because the rows are still loading, failed, are
 * locked or partial: not known to be gone. Its page says so and offers Retry, never "missing".
 */
export type WorkspaceRefUnconfirmed = Readonly<{ kind: 'unconfirmed'; status: ProjectAccountRowsStatus }>;

/** Deep links retain qualified candidates for the incumbent choose/repair surface. */
export function useWorkspaceRefResolutionById(workspaceRefId: string, explicitServerId?: string | null): WorkspaceRefResolutionV1 | WorkspaceRefUnconfirmed {
    const workspaceRefsV1 = useWorkspaceRefs();
    const census = useProjectAccountRows();
    const censusComplete = isProjectAccountRowsCensusComplete(census);
    const censusStatus = census?.status ?? 'idle';

    return React.useMemo(() => {
        const id = String(workspaceRefId ?? '').trim();
        const refs = Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [];
        const resolution = resolveWorkspaceRefById(refs, id, explicitServerId ?? undefined);
        if (resolution.kind === 'missing' && !censusComplete) return { kind: 'unconfirmed', status: censusStatus } as const;
        return resolution;
    }, [censusComplete, censusStatus, explicitServerId, workspaceRefId, workspaceRefsV1]);
}

export function useWorkspaceRefById(workspaceRefId: string, explicitServerId?: string | null): WorkspaceRefV1 | null {
    const result = useWorkspaceRefResolutionById(workspaceRefId, explicitServerId);
    return result.kind === 'resolved' ? result.ref : null;
}
