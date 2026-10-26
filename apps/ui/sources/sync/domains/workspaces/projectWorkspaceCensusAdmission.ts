import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceRefResolutionContextV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isSessionAccessOwner, type NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

type ProjectCensusSubject =
    | Readonly<{ kind: 'session'; ownerAccountId?: string; access?: NormalizedSessionAccessProjection | null; accessLevel?: unknown }>
    | Readonly<{ kind: 'run'; ownerAccountId: string }>;
type ProjectWorkspaceCensus = Readonly<{
    workspaceRefs?: readonly WorkspaceRefV1[];
    sessionProjectKeyResolver?: WorkspaceRefResolutionContextV1['sessionProjectKeyResolver'];
}>;
type ProjectWorkspaceCensusAdmission = ProjectWorkspaceCensus & Readonly<{ admitted: boolean }>;
const UNAVAILABLE_CENSUS: ProjectWorkspaceCensusAdmission = Object.freeze({ admitted: false });

/** Private checkout facts belong to the opened viewer Account/Home, not every readable row. */
export function admitProjectWorkspaceCensusForSubject(input: Readonly<{
    subject: ProjectCensusSubject;
    rowServerId: string;
    censusServerId?: string;
    viewerAccountId?: string;
}> & ProjectWorkspaceCensus): ProjectWorkspaceCensusAdmission {
    // 0.2 V1/V2 own rows omit ownerAccountId. Only the canonical wire adapter's
    // explicit owner projection may admit that shape; missing access is not proof.
    const ownerMatches = input.subject.ownerAccountId === undefined
        ? input.subject.kind === 'session' && input.subject.access?.role === 'owner'
        : Boolean(input.subject.ownerAccountId) && input.subject.ownerAccountId === input.viewerAccountId;
    if (!input.censusServerId || !input.viewerAccountId || !ownerMatches
        || !areServerProfileIdentifiersEquivalent(input.rowServerId, input.censusServerId)
        || (input.subject.kind === 'session' && !isSessionAccessOwner(input.subject.access, input.subject.accessLevel))) {
        return UNAVAILABLE_CENSUS;
    }
    return { admitted: true, workspaceRefs: input.workspaceRefs, sessionProjectKeyResolver: input.sessionProjectKeyResolver };
}
