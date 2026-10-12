import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { LruMap } from '@/utils/cache/lruMap';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListProjectHeaderViewModel = Readonly<{
    collapseKey: string;
    displayTitle: string;
    hasCustomLabel: boolean;
    workspaceRefId: string | null;
    legacyWorkspaceKey: string;
    scopeHint: WorkspaceScopeBase | null;
    seedSessionId: string | null;
    machineSubtitle?: string;
}>;

export type SessionListProjectHeaderViewModelState = Readonly<{
    projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel>;
    scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase>;
}>;

const EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE: SessionListProjectHeaderViewModelState = {
    projectHeaderViewModelByGroupKey: new Map<string, SessionListProjectHeaderViewModel>(),
    scopeHintByLegacyWorkspaceKey: new Map<string, WorkspaceScopeBase>(),
};

const SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE = new LruMap<string, SessionListProjectHeaderViewModelState>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

function appendCachePart(parts: string[], value: string): void {
    parts.push(value);
}

type ProjectHeaderProjectionInput = Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    workspaceLabels: Readonly<Record<string, string> | null | undefined>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    machinesById?: ReadonlyMap<string, Pick<MachineDisplayRenderable, 'id' | 'metadata' | 'availability'>>;
}>;

export function readSessionListProjectHeaderMachineId(item: Extract<SessionListIndexItem, { type: 'header' }>, workspaceRefs: readonly WorkspaceRefV1[]): string | null {
    const workspace = item.workspace;
    return item.workspaceScopeHint?.machineId ?? item.machine?.id
        ?? (workspace?.t === 'workspaceRef'
            ? workspaceRefs.find(ref => ref.id === workspace.workspaceRefId && ref.serverId === workspace.serverId)?.machineId
            : workspace?.machineId) ?? null;
}

function buildSessionListProjectHeaderViewModelStateCacheKey(input: ProjectHeaderProjectionInput, machineNames: ReadonlyMap<string, string>): string {
    const parts: string[] = ['session-list-project-header-view-model-state'];
    appendCachePart(parts, JSON.stringify([...machineNames].sort(([left], [right]) => left.localeCompare(right))));

    for (const [workspaceKey, workspaceLabel] of Object.entries(input.workspaceLabels ?? {}).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))) {
        appendCachePart(parts, `workspaceLabel:${workspaceKey}:${workspaceLabel}`);
    }

    for (const workspaceRef of input.workspaceRefs) {
        appendCachePart(parts, [
            'workspaceRef',
            String(workspaceRef.id ?? ''),
            String(workspaceRef.serverId ?? ''),
            String(workspaceRef.machineId ?? ''),
            String(workspaceRef.rootPath ?? ''),
            String(workspaceRef.label ?? ''),
        ].join('|'));
    }

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        appendCachePart(parts, [
            'projectHeader',
            String(item.groupKey ?? ''),
            String(item.title ?? ''),
            String(item.workspaceKey ?? ''),
            String(item.workspace?.t ?? ''),
            JSON.stringify(item.workspace ?? null),
            String(item.workspaceScopeHint?.serverId ?? ''),
            String(item.workspaceScopeHint?.machineId ?? ''),
            String(item.workspaceScopeHint?.rootPath ?? ''),
            String(item.seedSessionId ?? ''),
            String(item.serverId ?? ''),
            String(item.serverName ?? ''),
            String(item.subtitle ?? ''),
            String(readSessionListProjectHeaderMachineId(item, input.workspaceRefs) ?? ''),
        ].join('|'));
    }

    appendCachePart(parts, `workspacePathDisplayMode:${input.workspacePathDisplayModeV1 ?? 'name'}`);

    return parts.join('::');
}

export function buildSessionListProjectHeaderViewModels(input: ProjectHeaderProjectionInput): SessionListProjectHeaderViewModelState {
    const machines = new Map(input.machinesById);
    const unlistedMachineIds = new Set<string>();
    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') continue;
        const machineId = readSessionListProjectHeaderMachineId(item, input.workspaceRefs);
        if (!machineId || machines.has(machineId)) continue;
        if (item.machine) machines.set(machineId, item.machine);
        else if (input.machinesById) unlistedMachineIds.add(machineId);
    }
    const machineNames = resolveMachineDisplayNames([...machines.values(),
        ...[...unlistedMachineIds].filter(id => !machines.has(id)).map(id => ({ id, absence: 'unlisted' as const }))]);
    const cacheKey = buildSessionListProjectHeaderViewModelStateCacheKey(input, machineNames);
    const cachedState = SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.get(cacheKey);
    if (cachedState) {
        return cachedState;
    }

    let projectHeaderViewModelByGroupKey: Map<string, SessionListProjectHeaderViewModel> | null = null;
    let scopeHintByLegacyWorkspaceKey: Map<string, WorkspaceScopeBase> | null = null;

    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') {
            continue;
        }

        if (!projectHeaderViewModelByGroupKey || !scopeHintByLegacyWorkspaceKey) {
            projectHeaderViewModelByGroupKey = new Map<string, SessionListProjectHeaderViewModel>();
            scopeHintByLegacyWorkspaceKey = new Map<string, WorkspaceScopeBase>();
        }

        const groupKey = String(item.groupKey ?? '').trim();
        if (!groupKey) {
            continue;
        }

        const legacyWorkspaceKey = String(item.workspaceKey ?? '').trim();
        const workspace = item.workspace;
        const workspaceRef = workspace?.t === 'workspaceRef'
            ? input.workspaceRefs.find(ref => ref.id === workspace.workspaceRefId && ref.serverId === workspace.serverId)
            : null;
        const scopeHint = item.workspaceScopeHint ?? (workspace?.t === 'workspaceScope'
            && workspace.serverId && workspace.machineId
            ? { serverId: workspace.serverId, machineId: workspace.machineId, rootPath: workspace.rootPath }
            : workspaceRef ? { serverId: workspaceRef.serverId, machineId: workspaceRef.machineId, rootPath: workspaceRef.rootPath } : null);
        const seedSessionId = String(item.seedSessionId ?? '').trim() || null;
        if (legacyWorkspaceKey && scopeHint) {
            scopeHintByLegacyWorkspaceKey.set(legacyWorkspaceKey, scopeHint);
        }

        const legacyCustomLabel = item.workspace?.t !== 'managedSessions' && legacyWorkspaceKey
            ? input.workspaceLabels?.[legacyWorkspaceKey] ?? null
            : null;
        const presentation = resolveWorkspaceDisplayPresentation({
            scope: scopeHint,
            workspaceRefs: input.workspaceRefs,
            fallbackPathLabel: item.workspaceScopeHint ? item.title : scopeHint?.rootPath ?? item.title,
            fallbackPathDisplayMode: input.workspacePathDisplayModeV1,
            legacyLabel: legacyCustomLabel,
        });

        projectHeaderViewModelByGroupKey.set(groupKey, {
            collapseKey: groupKey,
            displayTitle: presentation.displayTitle,
            hasCustomLabel: presentation.hasCustomLabel,
            workspaceRefId: presentation.workspaceRefId,
            legacyWorkspaceKey,
            scopeHint,
            seedSessionId,
            machineSubtitle: machineNames.get(readSessionListProjectHeaderMachineId(item, input.workspaceRefs) ?? '') ?? item.subtitle,
        });
    }

    if (!projectHeaderViewModelByGroupKey || !scopeHintByLegacyWorkspaceKey) {
        return EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE;
    }

    const nextState: SessionListProjectHeaderViewModelState = {
        projectHeaderViewModelByGroupKey,
        scopeHintByLegacyWorkspaceKey,
    };

    SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.set(cacheKey, nextState);
    return nextState;
}
