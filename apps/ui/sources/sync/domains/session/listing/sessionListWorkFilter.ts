import type { SessionListFilterV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { matchSessionListFilterV1, readSessionListStartedByV1, type SessionListFilterFactsV1, type SessionListFilterMatchV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { projectSessionListFilterAfterHomeQueryV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterQueryV1';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectUiSessionAwareness } from '../awareness/sessionAwareness';
import { getSessionStorageKind } from '../sessionStorageKind';
import { readSessionListRenderableOwnerMetadataView } from './sessionListRenderableSessionProjection';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { readSessionListRenderableSourceMetadata } from './sessionListRenderable';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';

const ALL_STARTERS: SessionListFilterV1['startedBy'] = ['you', 'triggers', 'agents'];

export type SessionListRowFilterFactsOptions = Readonly<{
    nowMs: number;
    viewerAccountId?: string;
    workspaceRefs?: readonly WorkspaceRefV1[];
    storageKind?: 'persisted' | 'direct';
    scopeMatches?: SessionListFilterFactsV1['scopeMatches'];
    underSessionMatches?: boolean;
    audiences?: SessionListFilterFactsV1['audiences'];
    tagIds?: readonly string[];
    attentionRequired?: boolean;
    /** List consumers avoid awareness work unless their selected facet demands it. */
    includeStatus?: boolean;
    includeSource?: boolean;
}>;

/** Already authorized/opened row facts shared by the list, rule preview and Activity matching. */
export function buildSessionListRowFilterFacts(
    row: SessionListRenderableSession | Session | null,
    serverId: string,
    options: SessionListRowFilterFactsOptions,
): SessionListFilterFactsV1 {
    const hydrated = row !== null && 'agentState' in row;
    const metadata = row && !('metadataUnavailable' in row && row.metadataUnavailable)
        ? hydrated ? readSessionListRenderableSourceMetadata(row) : row.metadata : null;
    const ownerMetadata = metadata && row
        ? hydrated ? readSessionOwnerMetadataView(row) : readSessionListRenderableOwnerMetadataView(row) : null;
    const relevance = row?.viewer?.relevance;
    const follow = row?.viewer?.follow;
    const scopeMatches = options.scopeMatches ?? {
        ...(relevance ? { my_work: relevance.relevant,
            involving_me: relevance.reasons.some(reason => reason === 'owned_by_me' || reason === 'responsible_for_me'
                || reason === 'shared_directly_with_me' || reason === 'authored_by_me'),
            assigned_to_me: relevance.reasons.includes('responsible_for_me') } : {}),
        ...(follow ? { following: follow.follows } : {}),
    };
    return {
        serverId, kind: 'session',
        managedSessions: row?.managedSessions,
        receivedRuleCount: row?.receivedRuleCount,
        startedBy: readSessionListStartedByV1({ origin: row?.origin, ownerAccountId: row?.ownerAccountId, viewerAccountId: options.viewerAccountId }),
        metadata: metadata ? { bot: metadata.bot } : null,
        projectMetadata: ownerMetadata ? { projectId: ownerMetadata.projectId, workspaceId: ownerMetadata.workspaceId,
            machineId: ownerMetadata.machineId, path: ownerMetadata.path } : null,
        ...(options.includeStatus !== false && row ? { status: readSessionAwarenessPresentationV1(projectUiSessionAwareness(row, options.nowMs, { includeTitle: false, includeWorkspace: false })) } : {}),
        source: options.storageKind ?? (options.includeSource !== false && row
            ? getSessionStorageKind({ ...row, ownerMetadataView: ownerMetadata }) : undefined),
        attentionRequired: options.attentionRequired ?? row?.viewer?.attention.needsAttention,
        scopeMatches, underSessionMatches: options.underSessionMatches,
        audiences: options.audiences, tagIds: options.tagIds,
        workspaceRefs: options.workspaceRefs, workspaceContext: workspaceRefResolutionContextV1(),
    };
}

/**
 * Structural membership was proved before pagination by the Home listing owner.
 * Released Homes/cold placeholders may lack starter identity. That historical list admission
 * is not a rule fact: the constructor above always keeps missing evidence unavailable.
 */
export function matchSessionListRowLocalFilter(
    row: SessionListRenderableSession | null,
    serverId: string,
    filter: SessionListFilterV1,
    options: SessionListRowFilterFactsOptions,
): SessionListFilterMatchV1 {
    const facts = buildSessionListRowFilterFacts(row, serverId, { ...options,
        includeStatus: Boolean(filter.statuses?.length), includeSource: filter.source !== 'all' });
    return matchSessionListFilterV1({
        ...projectSessionListFilterAfterHomeQueryV1(filter, serverId), show: 'sessions',
        startedBy: facts.startedBy === undefined ? ALL_STARTERS : filter.startedBy,
    }, facts);
}

/** A mounted Home and a loaded window cannot certify unavailable Run filter facts. */
export function resolveWorkflowRunUnavailableHomes(input: Readonly<{
    selectedHomeServerIds: readonly string[];
    mountedHomeServerIds: readonly string[];
    servedHomeServerId: string | null;
    filter?: SessionListFilterV1;
    runs?: readonly (WorkflowRunSummaryV1 | null)[];
    viewerAccountId?: string;
    /** This page came from workflow.run.list with the exact Under filter. */
    runUnderSessionId?: string;
}>): readonly Readonly<{ serverId: string; reason: 'not_selected' | 'unsupported' }>[] {
    return input.selectedHomeServerIds.flatMap((serverId) => {
        if (input.servedHomeServerId
            && areServerProfileIdentifiersEquivalent(serverId, input.servedHomeServerId)) {
            const filter = input.filter;
            const unavailable = filter && input.runs?.some(run => (run
                ? matchWorkflowRunSessionListFilter(run, serverId, filter, input.viewerAccountId,
                    input.runUnderSessionId === filter.underSessionId && filter.underSessionId !== undefined ? true : undefined)
                : matchSessionListFilterV1(filter, { serverId, kind: 'run' })) === 'unavailable');
            if (!unavailable) return [];
        }
        const reason = input.mountedHomeServerIds.some((home) => areServerProfileIdentifiersEquivalent(home, serverId))
            ? 'unsupported' as const : 'not_selected' as const;
        return [{ serverId, reason }];
    });
}

/** Run-native evidence shared by strict rules/preview; no list attention admission is a fact. */
export function buildWorkflowRunFilterFacts(
    run: WorkflowRunSummaryV1,
    serverId: string,
    viewerAccountId?: string,
    underSessionMatches?: boolean,
): SessionListFilterFactsV1 {
    const ownedByViewer = viewerAccountId ? run.ownerAccountId === viewerAccountId : undefined;
    const starter = run.startedBy === 'user' ? ownedByViewer === undefined ? undefined : ownedByViewer ? 'you' : 'other_account'
        : run.startedBy === 'agent' ? 'agents'
        : run.startedBy === 'trigger' ? 'triggers' : undefined;
    return {
        serverId, kind: 'run', startedBy: starter, attentionRequired: run.attentionRequired,
        // Readability through a Team is not evidence of the viewer's participation.
        scopeMatches: { ...(ownedByViewer ? { my_work: true, involving_me: true } : {}), following: false, assigned_to_me: false },
        audiences: run.visibleTeamId === null ? [{ kind: 'outside_teams' }]
            : [{ kind: 'team', teamId: run.visibleTeamId }],
        tagIds: [], source: 'persisted',
        underSessionMatches,
        // A Run's destination is not owner Session Project/status evidence.
        workspaceContext: workspaceRefResolutionContextV1(),
    };
}

/** List/Board presentation retains its existing attention supplement, never rule match authority. */
export function matchWorkflowRunSessionListFilter(
    run: WorkflowRunSummaryV1,
    serverId: string,
    filter: SessionListFilterV1,
    viewerAccountId?: string,
    underSessionMatches?: boolean,
): SessionListFilterMatchV1 {
    return matchSessionListFilterV1(run.attentionRequired ? { ...filter, startedBy: ALL_STARTERS } : filter,
        buildWorkflowRunFilterFacts(run, serverId, viewerAccountId, underSessionMatches));
}

/** The same authorized lean Run membership predicate for Sessions and Boards. */
export function workflowRunMatchesSessionListFilter(
    run: WorkflowRunSummaryV1,
    serverId: string,
    filter: SessionListFilterV1,
    viewerAccountId?: string,
    underSessionMatches?: boolean,
): boolean {
    return matchWorkflowRunSessionListFilter(run, serverId, filter, viewerAccountId, underSessionMatches) === 'match';
}
