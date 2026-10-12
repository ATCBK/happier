import { getPathRemainderWithinBase } from '../../../../session/handoff/paths/sessionHandoffPathNormalization';
import type { LocalServiceProcessOwnership } from '@/processes/ownership/principal';
import type { ProcessCensusRow } from '@/processes/census/processCensus';

export type LocalServiceProcessFact = Readonly<{
    pid: number;
    ppid?: number;
    processStartTimeMs?: number;
    command: string;
    cwd?: string;
    censusRow?: ProcessCensusRow;
    censusMissing?: readonly string[];
    /**
     * Whether this process is controllable by the daemon's own OS identity, as established by
     * the census principal adapter. `undefined` means the platform
     * could not establish it, which the scanner treats as unproven, not as another owner.
     */
    processOwnership?: LocalServiceProcessOwnership;
}>;


export type LocalServiceWorkspaceFact = Readonly<{
    id?: string;
    path: string;
}>;

function isPathWithin(parent: string, child: string): boolean {
    // Reuse the canonical Windows-safe containment owner (drive-letter case-fold,
    // trailing-separator trim, mixed-separator normalize, sibling-prefix guard).
    // Do NOT hand-roll a second path normalizer here.
    return getPathRemainderWithinBase(child, parent) !== null;
}

/**
 * True when `candidate` is the workspace root `parent` or nested within it. Shared
 * path-containment owner for workspace-scope filtering (do not hand-roll `~`/path logic).
 */
export function isWorkspacePathWithin(parent: string, candidate: string): boolean {
    return isPathWithin(parent, candidate);
}

export function matchWorkspaceAssociation(input: Readonly<{
    cwd: string | undefined;
    workspaces: readonly LocalServiceWorkspaceFact[];
}>): Readonly<{
    workspace?: Readonly<{
        id?: string;
        path: string;
        association: 'cwd_containment';
    }>;
    workspaceAssociationConfidence: 'high' | 'medium' | 'low';
}> {
    if (!input.cwd) {
        return { workspaceAssociationConfidence: 'low' };
    }
    const matches = input.workspaces
        .filter((workspace) => isPathWithin(workspace.path, input.cwd as string))
        .sort((a, b) => b.path.length - a.path.length);
    const match = matches[0];
    if (!match) {
        return { workspaceAssociationConfidence: 'low' };
    }
    return {
        workspace: {
            ...(match.id ? { id: match.id } : {}),
            path: match.path,
            association: 'cwd_containment',
        },
        workspaceAssociationConfidence: 'high',
    };
}
