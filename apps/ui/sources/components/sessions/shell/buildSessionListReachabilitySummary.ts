import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListReachabilityRenderable } from '@/sync/domains/state/storage';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspacePathDisplayModeV1 } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { readDisplayMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readSessionListProjectHeaderMachineId } from './sessionListProjectHeaderViewModels';

type ReachabilityMachineDisplay = Readonly<Pick<MachineDisplayRenderable, 'id' | 'metadata' | 'replacedByMachineId'>>;

type ReachableSessionDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

type SessionDisplayRow = Readonly<{
    serverId: string | null;
    sessionId: string;
    sessionKey: string | null;
    machineKey: string;
    display: ReachableSessionDisplay;
}>;

type SessionListReachabilitySummaryCacheEntry = Readonly<{
    machineDisplaySignature: string;
    renderable: SessionListReachabilityRenderable | null;
    row: SessionDisplayRow;
    serverId?: string | null;
    sessionId: string;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>;

export type SessionListReachabilitySummaryCache = {
    entriesByKey: Map<string, SessionListReachabilitySummaryCacheEntry>;
    previousRows: readonly SessionDisplayRow[];
    previousSummary: SessionListReachabilitySummary | null;
};

export type SessionListReachabilitySummary = Readonly<{
    displayById: Map<string, ReachableSessionDisplay>;
    displayByKey: Map<string, ReachableSessionDisplay>;
    hasMultipleMachines: boolean;
}>;

const EMPTY_SESSION_LIST_REACHABILITY_SUMMARY: SessionListReachabilitySummary = {
    displayById: new Map<string, ReachableSessionDisplay>(),
    displayByKey: new Map<string, ReachableSessionDisplay>(),
    hasMultipleMachines: false,
};

export function createSessionListReachabilitySummaryCache(): SessionListReachabilitySummaryCache {
    return {
        entriesByKey: new Map<string, SessionListReachabilitySummaryCacheEntry>(),
        previousRows: [],
        previousSummary: null,
    };
}

export function retireSessionListReachabilitySummaryCacheServerScope(
    cache: SessionListReachabilitySummaryCache,
    serverId: string,
): void {
    for (const [key, entry] of cache.entriesByKey) {
        if (entry.serverId && areServerProfileIdentifiersEquivalent(entry.serverId, serverId)) {
            cache.entriesByKey.delete(key);
        }
    }
    cache.previousRows = cache.previousRows.filter((row) => (
        !row.serverId || !areServerProfileIdentifiersEquivalent(row.serverId, serverId)
    ));
    // The summary maps aggregate all rows. Rebuild them on the next render while
    // retaining unaffected per-row cache entries from the same valid lifetimes.
    cache.previousSummary = null;
}

function resolveRowCacheKey(item: Extract<SessionListIndexItem, { type: 'session' }>, sessionId: string): string {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    return serverId ? sessionAddressKey({ serverId, sessionId }) : sessionId;
}

function buildSessionDisplayRow(input: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machinesById: ReadonlyMap<string, ReachabilityMachineDisplay>;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): SessionDisplayRow {
    const serverId = typeof input.item.serverId === 'string' ? input.item.serverId.trim() : '';
    const metadata = input.renderable?.metadata ?? null;
    const machineTarget = readDisplayMachineTargetForSession({
        sessionId: input.sessionId,
        serverId,
        metadata,
    });
    const machineId = machineTarget?.machineId ?? (String(metadata?.machineId ?? '').trim() || null);
    const machineLabel = machineId
        ? getMachineDisplayName(input.machinesById.get(machineId))
            ?? String(metadata?.host ?? '').trim()
        : String(metadata?.host ?? '').trim();
    const workspaceDisplay = resolveSessionWorkspaceDisplayPresentation({
        serverId: input.item.serverId,
        metadata,
        machineTarget,
        workspaceRefs: input.workspaceRefs,
        workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
    });
    const display = {
        machineId,
        machineLabel,
        workspaceSubtitle: workspaceDisplay.displayTitle,
        workspaceSubtitleEllipsizeMode: workspaceDisplay.subtitleEllipsizeMode,
    } satisfies ReachableSessionDisplay;

    return {
        serverId: serverId || null,
        sessionId: input.sessionId,
        sessionKey: serverId
            ? sessionAddressKey({ serverId, sessionId: input.sessionId })
            : null,
        machineKey: machineId ?? machineLabel ?? '',
        display,
    };
}

function canReuseCacheEntry(input: Readonly<{
    cached: SessionListReachabilitySummaryCacheEntry | undefined;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machineDisplaySignature: string;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}>): input is Readonly<{
    cached: SessionListReachabilitySummaryCacheEntry;
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    machineDisplaySignature: string;
    renderable: SessionListReachabilityRenderable | null;
    sessionId: string;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
}> {
    return input.cached != null
        && input.cached.sessionId === input.sessionId
        && input.cached.serverId === input.item.serverId
        && input.cached.renderable === input.renderable
        && input.cached.machineDisplaySignature === input.machineDisplaySignature
        && input.cached.workspaceRefs === input.workspaceRefs
        && input.cached.workspacePathDisplayModeV1 === input.workspacePathDisplayModeV1;
}

function buildReachabilityMachineDisplaySignature(machines: ReadonlyMap<string, ReachabilityMachineDisplay>): string {
    // Display target resolution follows replacement links; labels use names and hosts.
    // Presence and heartbeat timestamps belong to the live status projection. Workspace
    // paths and home directories come from the separately cached session metadata.
    return JSON.stringify([...machines.keys()].sort().map((key) => {
        const machine = machines.get(key)!;
        return [key, machine.id, machine.replacedByMachineId ?? null,
            machine.metadata?.displayName ?? null, machine.metadata?.host ?? null];
    }));
}

function buildSessionDisplayRows(input: Readonly<{
    cache?: SessionListReachabilitySummaryCache;
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: ReadonlyMap<string, ReachabilityMachineDisplay>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
}>): readonly SessionDisplayRow[] {
    const machineDisplaySignature = buildReachabilityMachineDisplaySignature(input.machinesById);
    const rows: SessionDisplayRow[] = [];
    const nextCacheEntriesByKey = input.cache ? new Map<string, SessionListReachabilitySummaryCacheEntry>() : null;

    for (const item of input.listItems) {
        if (!item || item.type !== 'session') {
            continue;
        }

        const sessionId = String(item.sessionId ?? '').trim();
        if (!sessionId) continue;
        const renderable = input.resolveSessionRenderable(item);
        const rowCacheKey = resolveRowCacheKey(item, sessionId);
        const cached = input.cache?.entriesByKey.get(rowCacheKey);
        const canReuse = canReuseCacheEntry({
            cached,
            item,
            machineDisplaySignature,
            renderable,
            sessionId,
            workspaceRefs: input.workspaceRefs,
            workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
        });
        const row = canReuse && cached
            ? cached.row
            : buildSessionDisplayRow({
                item,
                machinesById: input.machinesById,
                renderable,
                sessionId,
                workspaceRefs: input.workspaceRefs,
                workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
            });
        rows.push(row);
        nextCacheEntriesByKey?.set(rowCacheKey, {
            machineDisplaySignature,
            renderable,
            row,
            serverId: item.serverId,
            sessionId,
            workspacePathDisplayModeV1: input.workspacePathDisplayModeV1,
            workspaceRefs: input.workspaceRefs,
        });
    }

    if (input.cache && nextCacheEntriesByKey) {
        input.cache.entriesByKey = nextCacheEntriesByKey;
    }

    return rows;
}

function areDisplayRowsReferenceEqual(left: readonly SessionDisplayRow[], right: readonly SessionDisplayRow[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((row, index) => row === right[index]);
}

function buildSummaryFromDisplayRows(rows: readonly SessionDisplayRow[], hasMultipleMachines: boolean): SessionListReachabilitySummary {
    if (rows.length === 0 && !hasMultipleMachines) {
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    const displayById = new Map<string, ReachableSessionDisplay>();
    const displayByKey = new Map<string, ReachableSessionDisplay>();
    for (const row of rows) {
        displayById.set(row.sessionId, row.display);
        if (row.sessionKey) {
            displayByKey.set(row.sessionKey, row.display);
        }
    }

    return {
        displayById,
        displayByKey,
        hasMultipleMachines,
    };
}

export function buildSessionListReachabilitySummary(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    machinesById: ReadonlyMap<string, ReachabilityMachineDisplay>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
    workspacePathDisplayModeV1?: WorkspacePathDisplayModeV1 | null;
    resolveSessionRenderable: (item: Extract<SessionListIndexItem, { type: 'session' }>) => SessionListReachabilityRenderable | null;
    cache?: SessionListReachabilitySummaryCache;
}>): SessionListReachabilitySummary {
    const rows = buildSessionDisplayRows(input);
    const machineKeys = new Set(rows.map(row => row.machineKey).filter(Boolean));
    for (const item of input.listItems) {
        if (item.type !== 'header' || item.headerKind !== 'project') continue;
        const machineId = readSessionListProjectHeaderMachineId(item, input.workspaceRefs);
        if (machineId) machineKeys.add(machineId);
    }
    const hasMultipleMachines = machineKeys.size > 1;

    if (rows.length === 0 && !hasMultipleMachines) {
        if (input.cache) {
            input.cache.previousRows = [];
            input.cache.previousSummary = EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
        }
        return EMPTY_SESSION_LIST_REACHABILITY_SUMMARY;
    }

    if (input.cache) {
        if (
            input.cache.previousSummary
            && input.cache.previousSummary.hasMultipleMachines === hasMultipleMachines
            && areDisplayRowsReferenceEqual(input.cache.previousRows, rows)
        ) {
            return input.cache.previousSummary;
        }
        const summary = buildSummaryFromDisplayRows(rows, hasMultipleMachines);
        input.cache.previousRows = rows;
        input.cache.previousSummary = summary;
        return summary;
    }

    return buildSummaryFromDisplayRows(rows, hasMultipleMachines);
}
