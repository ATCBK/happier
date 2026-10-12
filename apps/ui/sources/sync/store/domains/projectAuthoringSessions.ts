import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readProjectSessionAuthoringOrigin } from '@/sync/domains/workspaces/readProjectSessionAuthoringOrigin';
import { normalizeWorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

type ProjectAuthoringSessionInput = Readonly<{ sessionId: string; checkoutKey: string; updatedAt: number }>;
export type ProjectAuthoringSessionInputs = Readonly<Record<string, ProjectAuthoringSessionInput>>;
export const EMPTY_PROJECT_AUTHORING_SESSION_INPUTS: ProjectAuthoringSessionInputs = Object.freeze({});

export function projectAuthoringCheckoutKey(workspace: WorkspaceAddressV1, accountId: string): string | null {
    const scope = normalizeWorkspaceScopeBase(workspace);
    return scope ? JSON.stringify([accountId, workspace.workspaceId, scope.serverId, scope.machineId, scope.rootPath]) : null;
}

/** Sessions owns publication of the minimal inputs; list grouping and launch targets do not. */
export function updateProjectAuthoringSessionInputs(
    previous: ProjectAuthoringSessionInputs = EMPTY_PROJECT_AUTHORING_SESSION_INPUTS,
    sessionId: string,
    session: Session | undefined,
): ProjectAuthoringSessionInputs {
    const origin = session ? readProjectSessionAuthoringOrigin(readSessionOwnerMetadataView(session)) : null;
    const checkoutKey = origin?.page === 'scripts' && origin.purpose !== 'session'
        ? projectAuthoringCheckoutKey(origin.workspace, origin.accountId) : null;
    const existing = previous[sessionId];
    if (!checkoutKey || !session) {
        if (!existing) return previous;
        const next = { ...previous };
        delete next[sessionId];
        return next;
    }
    if (existing?.checkoutKey === checkoutKey && existing.updatedAt === session.updatedAt) return previous;
    return { ...previous, [sessionId]: { sessionId, checkoutKey, updatedAt: session.updatedAt } };
}
