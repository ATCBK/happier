import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import {
    readCurrentProjectAccountRows,
    readProjectAccountWorkspaceRefs,
    useProjectAccountRows,
    useProjectAccountWorkspaceRefs,
    type ProjectOrganizationRow,
} from '@/sync/domains/workspaces/projectAccountRows';
import { buildProjectGroupDisplayIndex, projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { resolveWorkspaceRefById, resolveWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { buildSessionFolderWorkspaceRefKey } from '../folders/workspaceRefs';
import { resolveSessionSectionChoiceLabels, type SessionSection } from './sections';

/** Display-only legacy context; the same admitted Project projection names list rows and headers. */
function projectChoiceLabels(
    sections: readonly SessionSection[],
    serverId: string,
    unavailableLabel: string,
    refs: readonly WorkspaceRefV1[] | undefined,
    organizations: readonly ProjectOrganizationRow[] | undefined,
): ReadonlyMap<string, string> {
    // Current membership still needs a truthful label when its display cannot
    // open. Destination eligibility remains with the chooser/menu owner.
    const choices = sections.filter(section => section.address.serverId === serverId);
    const projects = buildProjectGroupDisplayIndex(refs ?? [], organizations);
    const workspaceDisplayByKey: Record<string, string | null> = {};
    for (const section of choices) {
        const workspace = section.legacyContext?.workspace;
        if (!workspace || workspace.t === 'managedSessions') continue;
        const key = buildSessionFolderWorkspaceRefKey(workspace);
        if (Object.prototype.hasOwnProperty.call(workspaceDisplayByKey, key)) continue;
        const home = workspace.serverId ?? section.address.serverId;
        const resolved = workspace.t === 'workspaceRef'
            ? resolveWorkspaceRefById(refs ?? [], workspace.workspaceRefId, home)
            : workspace.machineId ? resolveWorkspaceRefByScope(refs ?? [], {
                serverId: home, machineId: workspace.machineId, rootPath: workspace.rootPath,
            }) : null;
        if (resolved?.kind === 'resolved') {
            workspaceDisplayByKey[key] = projects.get(projectGroupIdentityKey(projectWorkspaceRefV1(resolved.ref)))?.title ?? null;
        }
    }
    return resolveSessionSectionChoiceLabels(choices, { unavailableLabel, workspaceDisplayByKey });
}

/** Lazy row menus read only when opened, never once per mounted Session row. No loading or retained cache. */
export function readSessionSectionChoiceLabels(
    sections: readonly SessionSection[], serverId: string, unavailableLabel: string,
): ReadonlyMap<string, string> {
    const state = readRegisteredStorageState();
    const rows = state ? readCurrentProjectAccountRows(state) : null;
    const refs = readProjectAccountWorkspaceRefs({ projectAccountRows: rows });
    return projectChoiceLabels(sections, serverId, unavailableLabel, refs, refs ? rows?.organizations : undefined);
}

/** Mounted chooser/Info names follow Project renames and revoke held private names on Account changes. */
export function useSessionSectionChoiceLabels(
    sections: readonly SessionSection[], serverId: string, unavailableLabel: string,
): ReadonlyMap<string, string> {
    const enabled = sections.some(section => section.address.serverId === serverId && section.display.status === 'available'
        && section.legacyContext?.workspace && section.legacyContext.workspace.t !== 'managedSessions');
    const refs = useProjectAccountWorkspaceRefs(enabled);
    const organizations = useProjectAccountRows(rows => readProjectAccountWorkspaceRefs({ projectAccountRows: rows }) !== undefined
        ? rows?.organizations : undefined, enabled);
    return projectChoiceLabels(sections, serverId, unavailableLabel, refs, organizations);
}
