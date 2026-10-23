import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveWorkspaceDisplayPresentation } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { LruMap } from '@/utils/cache/lruMap';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { machineCollectionValues, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';

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

const SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE = new LruMap<string, ProjectHeaderCache>({
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
    machinesById?: MachineCollection<Pick<MachineDisplayRenderable, 'id' | 'metadata' | 'availability'>>;
}>;

type MachineNameSource = Parameters<typeof resolveMachineDisplayNames>[0][number];
type ProjectHeaderCache = {
    input: Omit<ProjectHeaderProjectionInput, 'machinesById' | 'listItems'>;
    listInputs: WeakSet<ReadonlyArray<SessionListIndexItem>>;
    state: SessionListProjectHeaderViewModelState;
    machines: Map<string, MachineNameSource>;
    names: Map<string, string>;
    idsByName: Map<string, Set<string>>;
    headersByMachine: Map<string, Map<string, string | undefined>>;
    fallbackMachines: Map<string, MachineNameSource>;
    hasMachineInventory: boolean;
};

function sameMachineNameInput(left: MachineNameSource | undefined, right: MachineNameSource | undefined): boolean {
    return left === right || Boolean(left && right
        && left.absence === right.absence
        && left.availability?.kind === right.availability?.kind
        && (left.metadata === null) === (right.metadata === null)
        && left.metadata?.displayName === right.metadata?.displayName
        && left.metadata?.host === right.metadata?.host);
}

function captureMachineNameInput(source: MachineNameSource): MachineNameSource {
    return { id: source.id, absence: source.absence,
        metadata: source.metadata ? { displayName: source.metadata.displayName, host: source.metadata.host } : source.metadata,
        availability: source.availability ? { kind: source.availability.kind } : source.availability };
}

/** Update only changed name collision groups, then only headers naming those Machines. */
function refreshMachineNames(cache: ProjectHeaderCache, input: ProjectHeaderProjectionInput): SessionListProjectHeaderViewModelState {
    const changedGroups = new Set<string>();
    const removedIds = new Set(cache.machines.keys());
    const update = (id: string, next: MachineNameSource | undefined) => {
        removedIds.delete(id);
        const previous = cache.machines.get(id);
        if (sameMachineNameInput(previous, next)) return;
        if (previous) {
            const group = getMachineDisplayName(previous).toLocaleLowerCase();
            cache.idsByName.get(group)?.delete(id);
            changedGroups.add(group);
        }
        if (next) {
            const group = getMachineDisplayName(next).toLocaleLowerCase();
            const ids = cache.idsByName.get(group) ?? new Set<string>();
            ids.add(id);
            cache.idsByName.set(group, ids);
            changedGroups.add(group);
            // This cache owns labels, not retained fleet/inventory payloads.
            cache.machines.set(id, captureMachineNameInput(next));
        } else cache.machines.delete(id);
    };
    for (const machine of machineCollectionValues(input.machinesById)) update(machine.id, machine);
    for (const id of removedIds) update(id, cache.fallbackMachines.get(id));
    // Fallbacks are added only once, including groups which never held an inventory record.
    for (const [id, machine] of cache.fallbackMachines) if (!cache.machines.has(id)) update(id, machine);
    const changedIds = new Set<string>();
    for (const group of changedGroups) {
        const ids = cache.idsByName.get(group);
        if (!ids?.size) { cache.idsByName.delete(group); continue; }
        const names = resolveMachineDisplayNames([...ids].map(id => cache.machines.get(id)!));
        for (const [id, name] of names) if (cache.names.get(id) !== name) {
            cache.names.set(id, name);
            changedIds.add(id);
        }
    }
    for (const id of [...cache.names.keys()]) if (!cache.machines.has(id)) { cache.names.delete(id); changedIds.add(id); }
    let headers = cache.state.projectHeaderViewModelByGroupKey;
    for (const id of changedIds) for (const [key, fallbackSubtitle] of cache.headersByMachine.get(id) ?? []) {
        const previous = headers.get(key);
        const machineSubtitle = cache.names.get(id) ?? fallbackSubtitle;
        if (!previous || previous.machineSubtitle === machineSubtitle) continue;
        if (headers === cache.state.projectHeaderViewModelByGroupKey) headers = new Map(headers);
        headers.set(key, { ...previous, machineSubtitle });
    }
    if (headers !== cache.state.projectHeaderViewModelByGroupKey) cache.state = { ...cache.state, projectHeaderViewModelByGroupKey: headers };
    const { machinesById: _machines, listItems, ...structuralInput } = input;
    cache.listInputs.add(listItems);
    cache.input = structuralInput;
    return cache.state;
}

export function readSessionListProjectHeaderMachineId(item: Extract<SessionListIndexItem, { type: 'header' }>, workspaceRefs: readonly WorkspaceRefV1[]): string | null {
    const workspace = item.workspace;
    return item.workspaceScopeHint?.machineId ?? item.machine?.id
        ?? (workspace?.t === 'workspaceRef'
            ? workspaceRefs.find(ref => ref.id === workspace.workspaceRefId && ref.serverId === workspace.serverId)?.machineId
            : workspace?.machineId) ?? null;
}

function buildSessionListProjectHeaderViewModelStateCacheKey(input: ProjectHeaderProjectionInput): string {
    const parts: string[] = ['session-list-project-header-view-model-state'];
    appendCachePart(parts, `machineInventory:${input.machinesById !== undefined}`);

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
            JSON.stringify(item.machine ?? null),
        ].join('|'));
    }

    appendCachePart(parts, `workspacePathDisplayMode:${input.workspacePathDisplayModeV1 ?? 'name'}`);

    return parts.join('::');
}

export function buildSessionListProjectHeaderViewModels(input: ProjectHeaderProjectionInput): SessionListProjectHeaderViewModelState {
    // The same bounded cache owns structural projection and keyed Machine invalidation.
    // Serialize structural inputs only after they change, never on a Machine receipt.
    for (const cached of SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.values()) {
        if (cached.listInputs.has(input.listItems) && cached.input.workspaceRefs === input.workspaceRefs
            && cached.input.workspaceLabels === input.workspaceLabels
            && cached.hasMachineInventory === (input.machinesById !== undefined)
            && cached.input.workspacePathDisplayModeV1 === input.workspacePathDisplayModeV1) return refreshMachineNames(cached, input);
    }
    const cacheKey = buildSessionListProjectHeaderViewModelStateCacheKey(input);
    const cached = SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.get(cacheKey);
    if (cached) return refreshMachineNames(cached, input);
    const headersByMachine: ProjectHeaderCache['headersByMachine'] = new Map();
    const fallbackMachines: ProjectHeaderCache['fallbackMachines'] = new Map();
    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') continue;
        const machineId = readSessionListProjectHeaderMachineId(item, input.workspaceRefs);
        if (!machineId) continue;
        const headers = headersByMachine.get(machineId) ?? new Map();
        headers.set(item.groupKey ?? '', item.subtitle);
        headersByMachine.set(machineId, headers);
        if (item.machine) fallbackMachines.set(machineId, captureMachineNameInput(item.machine));
        else if (input.machinesById) fallbackMachines.set(machineId, { id: machineId, absence: 'unlisted' });
    }
    const { machinesById: _machines, listItems, ...structuralInput } = input;
    const cache: ProjectHeaderCache = { input: structuralInput, state: EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE,
        listInputs: new WeakSet([listItems]),
        machines: new Map(), names: new Map(), idsByName: new Map(), headersByMachine, fallbackMachines,
        hasMachineInventory: input.machinesById !== undefined };
    refreshMachineNames(cache, input);
    const machineNames = cache.names;

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
        SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.set(cacheKey, cache);
        return EMPTY_SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE;
    }

    const nextState: SessionListProjectHeaderViewModelState = {
        projectHeaderViewModelByGroupKey,
        scopeHintByLegacyWorkspaceKey,
    };

    cache.state = nextState;
    SESSION_LIST_PROJECT_HEADER_VIEW_MODEL_STATE_CACHE.set(cacheKey, cache);
    return nextState;
}
