import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionListHomeObservation, SessionListHomeObservationByServerId } from '@/sync/domains/session/listing/sessionListHomeObservation';
import type {
    SessionListContextualSearchReason,
    SessionListIndexItem,
} from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListSecondaryLineMode } from '@/sync/domains/session/listing/deriveSessionListActivity';
import {
    areSessionListRenderablesEqual,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import type { SessionListGuardState } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    readSessionRuntimePresentationFreshnessExpirations,
} from '@/sync/domains/session/attention/runtimePresentation';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
    readSessionHomeLastUpdatedRefreshAtMs,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import {
    resolveSessionAttentionStanding,
    resolveSessionReminderPresentation,
    type SessionAttentionStandingPolicy,
    type SessionReminderPresentation,
} from '@/sync/domains/session/organization/attentionStanding';
import type { WorkspaceDisplayEllipsizeMode } from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { getSessionName, getSessionStatus, isUntitledSessionName, type SessionStatus, type SessionWorkingTextMode } from '@/utils/sessions/sessionUtils';
import { formatShortRelativeTimeAt, readShortRelativeTimeRefreshAtMs } from '@/utils/time/formatShortRelativeTime';
import { LruMap } from '@/utils/cache/lruMap';
import { t } from '@/text';
import type { ExistingSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { getTagsForSession, sessionTagKey } from './sessionTagUtils';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';
import {
    readExternalAgentObservationPresentationInput,
    resolveExternalAgentPresentationState,
    resolveExternalSessionRuntimePresentation,
    type ExternalSessionRuntimePresentation,
} from '../presentation/externalSessionRuntimePresentation';
import {
    resolveExternalSessionIdentityPresentation,
    type ExternalSessionIdentityPresentation,
} from '../presentation/externalSessionIdentityPresentation';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';

function appendUniqueSearchReason(
    reasons: SessionListContextualSearchReason[],
    reason: SessionListContextualSearchReason,
): void {
    if (!reasons.includes(reason)) reasons.push(reason);
}

function resolveContextualSearchSubtitle(input: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    session: SessionListRenderableSession | null;
}>): string | null {
    if (!input.item.contextualSearchReasons?.length) return null;

    const reasons = [...input.item.contextualSearchReasons];
    if (input.session?.archivedAt != null) appendUniqueSearchReason(reasons, 'archived');
    if (readExternalSessionLink(input.session?.metadata)) appendUniqueSearchReason(reasons, 'external');

    const sourceMachineId = String(input.item.contextualSearchSourceMachineId ?? '').trim();
    const sessionMachineId = String(input.session?.metadata?.machineId ?? '').trim();
    if (sourceMachineId && sessionMachineId && sourceMachineId !== sessionMachineId) {
        appendUniqueSearchReason(reasons, 'another-machine');
    }

    const labelByReason = {
        transcript: t('sessionsList.searchMatchTranscript'),
        'hidden-by-filters': t('sessionsList.searchMatchHiddenByFilters'),
        archived: t('sessionsList.searchMatchArchived'),
        external: t('sessionsList.searchMatchExternal'),
        'another-machine': t('sessionsList.searchMatchAnotherMachine'),
    } as const;
    return reasons.map((reason) => labelByReason[reason]).join(' · ');
}

export type SessionReachableDisplay = Readonly<{
    machineId: string | null;
    machineLabel: string;
    workspaceSubtitle: string;
    workspaceSubtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
}>;

export type SessionListRowViewModel = Readonly<{
    groupKey: string;
    sessionKey: string | null;
    session: SessionListRenderableSession | null;
    sessionStatus: SessionStatus | null;
    externalSessionRuntime: ExternalSessionRuntimePresentation | null;
    externalSessionIdentity: ExternalSessionIdentityPresentation | null;
    isIdentityLoading: boolean;
    nextRuntimeFreshnessAtMs: number | null;
    hasUnreadMessages: boolean;
    activityTimeLabel: string;
    workingIndicatorMode: 'spinner' | 'pulse';
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
    activeColorMode: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions: boolean;
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
    subtitleOverride: string | null;
    subtitleEllipsizeMode: WorkspaceDisplayEllipsizeMode;
    pinned: boolean;
    showServerBadge: boolean;
    selected: boolean;
    tags: string[];
    secondaryLineMode: ReturnType<typeof resolveSessionListSecondaryLineMode>;
    /**
     * Retained working placement: the session is held in the working group
     * while its live signals are stale. Rows render the working indicator
     * WITHOUT animation for it, with a dedicated status text.
     */
    workingPlacementRetained: boolean;
    /**
     * The row sits in Needs attention only because the user asked it to. It
     * comes off the placement reason rather than the stored bit on purpose: a
     * kept session that is currently placed for being unread has something of
     * its own to say and must not be presented as merely kept.
     */
    attentionStanding: boolean;
    /**
     * The stored bit `resolveSessionAttentionStanding` returns for this row, NOT
     * the placement outcome above. Action surfaces must offer Remove for a kept
     * session even while it is currently placed for being unread, so the row
     * menu target reads this and never `attentionStanding`.
     */
    isAttentionStanding: boolean;
    reminder: SessionReminderPresentation | null;
    /** Whether the Keep / Remove action means anything at all (attention band on). */
    attentionStandingEnabled: boolean;
    draft: ExistingSessionDraftProjection | null;
    /** A guard stop is coming ("Stops in 4:52") or the guard stopped this session (plan 50 G3-2). */
    guardState: SessionListGuardState | null;
}>;

export type SessionListRowViewModelAdjacency = Readonly<{
    isFirst: boolean;
    isLast: boolean;
    isSingle: boolean;
}>;

const EMPTY_SESSION_LIST_ROW_VIEW_MODELS: ReadonlyArray<SessionListRowViewModel | null> = [];

type RowViewModelCacheEntry = Readonly<{
    sessionRef: SessionListRenderableSession | null;
    signature: string;
    value: SessionListRowViewModel;
}>;

const SESSION_LIST_ROW_VIEW_MODEL_CACHE = new LruMap<string, RowViewModelCacheEntry>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export type BuildSessionListRowViewModelInput = Readonly<{
    item: Extract<SessionListIndexItem, { type: 'session' }>;
    adjacency: SessionListRowViewModelAdjacency;
    unscopedSelectionIsUnique: boolean;
    reachableSessionDisplay?: SessionReachableDisplay;
    reachableSessionDisplayById?: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey?: ReadonlyMap<string, SessionReachableDisplay>;
    rowRenderableByKey?: ReadonlyMap<string, SessionListRenderableSession>;
    audienceScopes?: ReadonlyMap<string, ServerAccountScope>;
    /** Exact-Home list currentness from the canonical per-Home observation owner. */
    homeObservations?: SessionListHomeObservationByServerId;
    relativeNowMs?: number;
    runtimeNowMs?: number;
    workingIndicatorMode?: 'spinner' | 'pulse';
    workingTextMode?: SessionWorkingTextMode;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none';
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions?: boolean;
    hasMultipleMachines: boolean;
    pinnedSessionKeys: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    selectedSessionId: string | null;
    selectedSessionServerId?: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    attentionStandingEnabled?: boolean;
    attentionStandingPolicy?: SessionAttentionStandingPolicy;
    existingDraft?: ExistingSessionDraftProjection | null;
}>;

/** Row-local deadline selection on the existing shared clock, not a per-row timer. */
export function readSessionListRowRefreshAtMs(input: Readonly<{
    session: SessionListRenderableSession | null;
    reminderAtMs: number | null;
    homeObservation?: SessionListHomeObservation | null;
}>, nowMs: number): number | null {
    const session = input.session;
    const activityAt = session ? resolveSessionListRenderableMeaningfulActivityAt(session) : null;
    const externalExpiryAtMs = session && readExternalSessionLink(session.metadata)
        ? resolveExternalAgentPresentationState(readExternalAgentObservationPresentationInput(session.metadata), nowMs).nextExpiryAtMs
        : null;
    return resolveEarliestFreshnessAtMs(
        resolveEarliestFreshnessAtMs(session ? resolveNextRuntimeFreshnessAtMs(session, nowMs) : null, externalExpiryAtMs),
        resolveEarliestFreshnessAtMs(
            resolveEarliestFreshnessAtMs(
                activityAt !== null && activityAt > 0 ? readShortRelativeTimeRefreshAtMs(activityAt, nowMs) : null,
                readSessionHomeLastUpdatedRefreshAtMs(input.homeObservation, nowMs),
            ),
            input.reminderAtMs !== null && input.reminderAtMs > nowMs ? input.reminderAtMs : null,
        ),
    );
}

export function buildSessionListRowViewModel(input: BuildSessionListRowViewModelInput): SessionListRowViewModel {
    const item = input.item;
    const groupKey = String(item.groupKey ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionKey = serverId && sessionId ? sessionTagKey(serverId, sessionId) : null;
    const rowKey = buildSessionListServerScopedRowKey(serverId, sessionId);
    const pinned = item.pinned === true || (sessionKey ? input.pinnedSessionKeys.has(sessionKey) : false);
    const reachableDisplay = input.reachableSessionDisplay
        ?? (sessionKey ? input.reachableSessionDisplayByKey?.get(sessionKey) : undefined)
        ?? input.reachableSessionDisplayById?.get(sessionId);
    const workspaceSubtitle = reachableDisplay?.workspaceSubtitle ?? '';
    const subtitleEllipsizeMode = reachableDisplay?.workspaceSubtitleEllipsizeMode ?? 'head';
    const machineLabel = reachableDisplay?.machineLabel ?? '';
    const workspaceLabel = input.hasMultipleMachines
        ? (machineLabel && workspaceSubtitle ? `${machineLabel} · ${workspaceSubtitle}` : machineLabel || workspaceSubtitle)
        : workspaceSubtitle;
    const session = rowKey ? input.rowRenderableByKey?.get(rowKey) ?? null : null;
    const relativeNowMs = normalizeClockNow(input.relativeNowMs);
    const runtimeNowMs = normalizeClockNow(input.runtimeNowMs);
    const activityAt = session ? resolveSessionListRenderableMeaningfulActivityAt(session) : null;
    const activityTimeLabel = typeof activityAt === 'number' && activityAt > 0
        ? formatShortRelativeTimeAt(activityAt, relativeNowMs)
        : '';
    const sessionStatus = session
        ? getSessionStatus(session, runtimeNowMs, {
            vibingIndex: resolveStableVibingIndex(sessionKey ?? sessionId),
            workingTextMode: input.workingTextMode ?? 'animated',
        })
        : null;
    const sessionMetadata = session?.metadata;
    const externalSessionLink = readExternalSessionLink(sessionMetadata);
    const externalSessionIdentity = externalSessionLink
        ? resolveExternalSessionIdentityPresentation(sessionMetadata, reachableDisplay?.machineId)
        : null;
    const externalSessionRuntime = externalSessionLink && sessionStatus
        ? resolveExternalSessionRuntimePresentation({
            controlConnectivity: sessionStatus.isConnected ? 'connected' : 'offline',
            detachedActivity: sessionStatus.awareness?.runtime === 'background_active'
                ? 'active'
                : sessionStatus.isConnected
                    ? 'idle'
                    : 'unknown',
            externalAgent: readExternalAgentObservationPresentationInput(sessionMetadata),
            nowMs: runtimeNowMs,
        })
        : null;
    const sessionName = session ? getSessionName(session, serverId) : '';
    const contextualSearchSubtitle = resolveContextualSearchSubtitle({ item, session });
    const selectedSessionServerId = String(input.selectedSessionServerId ?? '').trim();
    // One quiet secondary line, composed by the shared context owner rather than here: it decides
    // whether this viewer may see the workspace at all and adds the single responsibility marker.
    // The Home stays with the incumbent server badge, so it is deliberately not a segment here.
    const subtitle = serverId && sessionId
        ? projectSessionContextPresentation(buildSessionContextFacts({
            address: { serverId, sessionId },
            awareness: sessionStatus?.awareness ?? null,
            viewer: session?.viewer,
            audienceContext: session?.access?.audienceContext,
            audienceScope: input.audienceScopes?.get(serverId),
            workspaceLabel,
            homeObservation: input.homeObservations?.[serverId] ?? null,
            nowMs: relativeNowMs,
        })).contextLine ?? ''
        : workspaceLabel;
    const reminder = input.attentionStandingPolicy && sessionKey
        ? resolveSessionReminderPresentation(input.attentionStandingPolicy.overridesBySessionKey[sessionKey], runtimeNowMs)
        : null;
    const reminderWakeAtMs = reminder?.state === 'scheduled' ? reminder.remindAt : null;

    const rowViewModel: SessionListRowViewModel = {
        groupKey,
        sessionKey,
        session,
        sessionStatus,
        externalSessionRuntime,
        externalSessionIdentity,
        // A row whose canonical renderable has not landed yet is still materializing.
        // It renders the identity transition affordance rather than a blank row that
        // reads as a real session with no name.
        isIdentityLoading: session ? resolveRowIdentityLoading({
            session,
            title: sessionName,
        }) : true,
        nextRuntimeFreshnessAtMs: resolveEarliestFreshnessAtMs(
            resolveEarliestFreshnessAtMs(
                session ? resolveNextRuntimeFreshnessAtMs(session, runtimeNowMs) : null,
                externalSessionRuntime?.externalAgent.nextExpiryAtMs ?? null,
            ),
            reminderWakeAtMs,
        ),
        hasUnreadMessages: session?.hasUnreadMessages === true,
        activityTimeLabel,
        workingIndicatorMode: input.workingIndicatorMode === 'pulse' ? 'pulse' : 'spinner',
        identityDisplay: input.identityDisplay === 'agentLogo' || input.identityDisplay === 'none' ? input.identityDisplay : 'avatar',
        activeColorMode: normalizeActiveColorMode(input.activeColorMode),
        hideInactiveSessions: input.hideInactiveSessions === true,
        isFirst: input.adjacency.isFirst,
        isLast: input.adjacency.isLast,
        isSingle: input.adjacency.isSingle,
        subtitleOverride: contextualSearchSubtitle
            ?? (item.groupKind === 'project' && item.variant === 'no-path' ? null : (subtitle || null)),
        subtitleEllipsizeMode,
        pinned,
        showServerBadge: pinned ? input.showPinnedServerBadge : input.showServerBadge,
        selected: input.selectedSessionId != null
            && input.selectedSessionId === sessionId
            && (
                selectedSessionServerId
                    ? selectedSessionServerId === serverId
                    : input.unscopedSelectionIsUnique
            ),
        tags: getTagsForSession(input.sessionTags, sessionKey ?? ''),
        secondaryLineMode: resolveSessionListSecondaryLineMode({ groupKind: item.groupKind }),
        workingPlacementRetained: item.workingPlacementReason === 'working-retained',
        attentionStanding: item.attentionPlacementReason === 'standing',
        isAttentionStanding: input.attentionStandingPolicy != null && sessionKey != null
            ? resolveSessionAttentionStanding(input.attentionStandingPolicy, sessionKey, runtimeNowMs)
            : false,
        reminder,
        attentionStandingEnabled: input.attentionStandingEnabled === true && sessionKey != null,
        draft: input.existingDraft ?? null,
        // A stopped session that is working again (it woke on a message) shows its working state instead.
        guardState: session?.guardState?.kind === 'stopped' && session.active ? null : session?.guardState ?? null,
    };
    const signature = buildRowViewModelSignature(rowViewModel);
    const cacheKey = sessionKey ?? `session:${sessionId}`;
    const cached = SESSION_LIST_ROW_VIEW_MODEL_CACHE.get(cacheKey);
    if (
        cached?.signature === signature
        && (
            cached.sessionRef === session
            || (cached.sessionRef != null && session != null && areSessionListRenderablesEqual(cached.sessionRef, session))
        )
    ) {
        return cached.value;
    }
    SESSION_LIST_ROW_VIEW_MODEL_CACHE.set(cacheKey, {
        sessionRef: session,
        signature,
        value: rowViewModel,
    });
    return rowViewModel;
}

export function resolveSessionListRowViewModelAdjacency(
    listItems: ReadonlyArray<SessionListIndexItem>,
    index: number,
): SessionListRowViewModelAdjacency {
    const item = listItems[index];
    if (!item || item.type === 'header') return { isFirst: true, isLast: true, isSingle: true };
    // A group sheet runs from one heading to the next: consecutive rows share it even when their
    // placement groups differ (a working band flowing into its section), and a header that draws no
    // heading (no title, `resolveSessionListHeaderViewState`) does not cut it, so no sheet is unlabeled.
    const previous = neighbourOf(listItems, index, -1);
    const next = neighbourOf(listItems, index, 1);
    const isFirst = previous == null || previous.type === 'header';
    const isLast = next == null || next.type === 'header';
    return { isFirst, isLast, isSingle: isFirst && isLast };
}

function neighbourOf(
    listItems: ReadonlyArray<SessionListIndexItem>,
    index: number,
    step: -1 | 1,
): SessionListIndexItem | null {
    for (let cursor = index + step; cursor >= 0 && cursor < listItems.length; cursor += step) {
        const item = listItems[cursor]!;
        if (item.type === 'header' && !item.title) continue;
        return item;
    }
    return null;
}

export function resolveSessionListUnscopedSelectionIsUnique(
    listItems: ReadonlyArray<SessionListIndexItem>,
    selectedSessionId: string | null,
): boolean {
    if (!selectedSessionId) return false;
    let matches = 0;
    for (const candidate of listItems) {
        if (candidate.type !== 'session' || candidate.sessionId !== selectedSessionId) continue;
        matches += 1;
        if (matches > 1) return false;
    }
    return matches === 1;
}

export function buildSessionListRowViewModels(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem>;
    reachableSessionDisplayById: ReadonlyMap<string, SessionReachableDisplay>;
    reachableSessionDisplayByKey?: ReadonlyMap<string, SessionReachableDisplay>;
    rowRenderableByKey?: ReadonlyMap<string, SessionListRenderableSession>;
    audienceScopes?: ReadonlyMap<string, ServerAccountScope>;
    /** Exact-Home list currentness from the canonical per-Home observation owner. */
    homeObservations?: SessionListHomeObservationByServerId;
    relativeNowMs?: number;
    runtimeNowMs?: number;
    workingIndicatorMode?: 'spinner' | 'pulse';
    workingTextMode?: SessionWorkingTextMode;
    identityDisplay?: 'avatar' | 'agentLogo' | 'none';
    activeColorMode?: 'activityAndAttention' | 'attentionOnly' | 'allActive';
    hideInactiveSessions?: boolean;
    hasMultipleMachines: boolean;
    pinnedSessionKeys: ReadonlySet<string>;
    sessionTags: Record<string, string[]>;
    selectedSessionId: string | null;
    selectedSessionServerId?: string | null;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
    attentionStandingEnabled?: boolean;
    attentionStandingPolicy?: SessionAttentionStandingPolicy;
}>): ReadonlyArray<SessionListRowViewModel | null> {
    if (input.listItems.length === 0) {
        return EMPTY_SESSION_LIST_ROW_VIEW_MODELS;
    }

    const next = input.listItems.map((item, index) => {
        if (item.type !== 'session') {
            return null;
        }

        return buildSessionListRowViewModel({
            ...input,
            item,
            adjacency: resolveSessionListRowViewModelAdjacency(input.listItems, index),
            unscopedSelectionIsUnique: !String(input.selectedSessionServerId ?? '').trim()
                && input.selectedSessionId === item.sessionId
                && resolveSessionListUnscopedSelectionIsUnique(input.listItems, input.selectedSessionId),
        });
    });
    return next;
}

function buildRowViewModelSignature(viewModel: SessionListRowViewModel): string {
    return JSON.stringify([
        viewModel.groupKey,
        viewModel.sessionKey ?? '',
        viewModel.sessionStatus?.state ?? '',
        viewModel.sessionStatus?.statusText ?? '',
        viewModel.sessionStatus?.shouldShowStatus === true ? '1' : '0',
        viewModel.externalSessionRuntime?.controlConnectivity ?? '',
        viewModel.externalSessionRuntime?.detachedActivity ?? '',
        viewModel.externalSessionRuntime?.externalAgent.state ?? '',
        viewModel.externalSessionRuntime?.externalAgent.nextExpiryAtMs ?? '',
        viewModel.externalSessionIdentity?.agentId ?? '',
        viewModel.externalSessionIdentity?.identityLabel ?? '',
        viewModel.externalSessionIdentity?.rowMetadataLabel ?? '',
        viewModel.isIdentityLoading ? '1' : '0',
        viewModel.nextRuntimeFreshnessAtMs ?? '',
        viewModel.hasUnreadMessages ? '1' : '0',
        viewModel.activityTimeLabel,
        viewModel.workingIndicatorMode,
        viewModel.identityDisplay,
        viewModel.activeColorMode,
        viewModel.hideInactiveSessions ? '1' : '0',
        viewModel.isFirst ? '1' : '0',
        viewModel.isLast ? '1' : '0',
        viewModel.isSingle ? '1' : '0',
        viewModel.subtitleOverride ?? '',
        viewModel.subtitleEllipsizeMode,
        viewModel.pinned ? '1' : '0',
        viewModel.showServerBadge ? '1' : '0',
        viewModel.selected ? '1' : '0',
        viewModel.tags,
        viewModel.secondaryLineMode,
        viewModel.workingPlacementRetained ? '1' : '0',
        viewModel.attentionStanding ? '1' : '0',
        viewModel.isAttentionStanding ? '1' : '0',
        viewModel.reminder?.state ?? '',
        viewModel.reminder?.remindAt ?? '',
        viewModel.attentionStandingEnabled ? '1' : '0',
        viewModel.draft?.updatedAt ?? '',
        viewModel.draft?.preview ?? '',
        viewModel.draft?.status ?? '',
        viewModel.guardState?.kind ?? '',
        viewModel.guardState?.kind === 'stopping' ? viewModel.guardState.stopAt : '',
    ]);
}

function normalizeClockNow(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function resolveEarliestFreshnessAtMs(
    first: number | null,
    second: number | null,
): number | null {
    if (first === null) return second;
    if (second === null) return first;
    return Math.min(first, second);
}

function normalizeActiveColorMode(
    value: 'activityAndAttention' | 'attentionOnly' | 'allActive' | null | undefined,
): 'activityAndAttention' | 'attentionOnly' | 'allActive' {
    return value === 'attentionOnly' || value === 'allActive' ? value : 'activityAndAttention';
}

function resolveStableVibingIndex(key: string): number {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
        hash = ((hash * 31) + key.charCodeAt(index)) >>> 0;
    }
    return hash;
}

function resolveRowIdentityLoading(input: Readonly<{
    session: SessionListRenderableSession;
    title: string;
}>): boolean {
    const metadataUnavailable = input.session.metadataUnavailable === true;
    return !metadataUnavailable
        && input.session.metadata == null
        && isUntitledSessionName(input.title);
}

function resolveNextRuntimeFreshnessAtMs(session: SessionListRenderableSession, nowMs: number): number | null {
    if (session.presence !== 'online') return null;

    const expirations = readSessionRuntimePresentationFreshnessExpirations({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt,
        hasPendingUserMessages: typeof session.pendingCount === 'number' && session.pendingCount > 0,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: session.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        hasPendingPermissionRequests: session.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests: session.hasPendingUserActionRequests === true,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
    }, nowMs);

    if (expirations.length === 0) return null;
    return Math.min(...expirations);
}
