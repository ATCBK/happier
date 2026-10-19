import * as React from 'react';
import { editFollowPolicyV1, projectFollowPolicyEditorV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionFollowSourceKeyPreparationWaitingReasonV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useIsTablet } from '@/utils/platform/responsive';
import {
    listSessionFollowSources,
    removeSessionFollowSource,
    setSessionFollowSource,
} from '@/sync/api/session/sessionFollowSourcesApi';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { useActiveServerAccountScope, useServerScopedMachine, useSessionListRowsByServerId } from '@/sync/domains/state/storage';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import {
    isServerReachabilityNetworkAllowed,
    subscribeServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import {
    refineSessionFollowSourceStateWithPreparationReason,
    resolveSessionFollowSourceRuntimeState,
    sessionFollowSourceRuntimeStateLabel,
} from './sessionFollowSourcePresentation';
import { FollowEditorPanel } from './FollowEditorPanel';
import { FollowPolicyEditorBinding, FollowPolicySection } from './FollowPolicyEditorBinding';
import { FollowSessionMark } from './FollowSessionMark';
import { describeSessionFollowLevel } from './sessionFollowLevelCopy';
import { openSessionFollowSourcePicker } from './openSessionFollowDestinationPicker';
import {
    prepareSessionFollowSourceKey,
} from './prepareSessionFollowSourceKey';
import {
    createIdleSessionFollowMutationIntent,
    reduceSessionFollowMutationIntent,
    type SessionFollowMutationIntentEvent,
    type SessionFollowMutationIntentState,
} from './sessionFollowMutationIntent';

function sourcePreparationKey(preparationTargetKey: string, sourceSessionId: string): string {
    return `${preparationTargetKey}\u0000${sourceSessionId}`;
}

type SessionFollowSourceMutationRequest = Readonly<{
    targetKey: string;
    sourceSessionId: string;
}>;

/**
 * The exact operation a failed Stop-following or policy change owes: reloading the list is not a
 * retry of either, and a successful reload must not make the error disappear while the relation
 * is still active and still supplying updates.
 */
type SessionFollowSourceIntent =
    | Readonly<{ kind: 'remove'; sourceSessionId: string }>
    | Readonly<{ kind: 'policy'; sourceSessionId: string; policy: FollowPolicyV1 }>;

function reduceSourceMutation(
    state: SessionFollowMutationIntentState<SessionFollowSourceIntent>,
    event: SessionFollowMutationIntentEvent<SessionFollowSourceIntent>,
): SessionFollowMutationIntentState<SessionFollowSourceIntent> {
    return reduceSessionFollowMutationIntent(state, event);
}

type FollowSourcePanelParts = Readonly<{
    title: string;
    subtitle: string;
    mark: React.ReactNode;
    body: React.ReactNode;
    footer: React.ReactNode;
}>;

/**
 * A source row's anchor: the row sits in a view that anchors its own Follow panel, and hands the panel's
 * focus-return ref to the row's pressable.
 */
function SourceRowAnchor(props: Readonly<{
    row: (triggerRef: React.RefObject<React.ComponentRef<typeof Pressable> | null>) => React.ReactNode;
    panel: ((refs: Readonly<{
        anchorRef: React.RefObject<View | null>;
        triggerRef: React.RefObject<React.ComponentRef<typeof Pressable> | null>;
    }>) => React.ReactNode) | null;
}>) {
    const anchorRef = React.useRef<View>(null);
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    return <>
        <View ref={anchorRef} collapsable={false}>{props.row(triggerRef)}</View>
        {props.panel?.({ anchorRef, triggerRef })}
    </>;
}

/**
 * The Sessions this one follows (lab P1-P, P2-S). Inside a page (`ListPresentationProvider value="page"`) it is two
 * grouped sections, "Following" and "Add". Anywhere else it is one flat section of a side pane (People): a heading
 * with its count and "+", then flat rows, drawn like the pane's Discussions. The pane mounts it with no list
 * presentation around it.
 *
 * A row opens that source's Follow panel (title, how much it hears, Stop updates · Done): anchored to the row on
 * a wide window, a pushed page on a phone. `page` is that pushed page: the same editor, controller and writers
 * place one source's panel through its `frame` instead of the list.
 */
export function SessionFollowSourcesEditor(props: Readonly<{
    /** The Session that follows: its identity is all the list needs, so it shows before the Session's own snapshot lands. */
    destination: Readonly<{ id: string }>;
    serverId: string | null;
    destinationMachineId: string | null;
    page?: Readonly<{
        sourceSessionId: string;
        frame(parts: FollowSourcePanelParts): React.ReactNode;
        onClose(): void;
    }>;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const anchored = useIsTablet();
    const pane = useListPresentation() !== 'page';
    const rowLook = pane ? { density: 'compact' as const, showDivider: false } : {};
    const online = React.useSyncExternalStore(
        React.useCallback((listener) => subscribeServerReachabilityNetworkAllowed(() => listener()), []),
        isServerReachabilityNetworkAllowed,
        isServerReachabilityNetworkAllowed,
    );
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.serverId });
    const rowsByServerId = useSessionListRowsByServerId();
    const activeScope = useActiveServerAccountScope();
    const currentScope = selectActiveServerAccountScopeForServer(activeScope, props.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(currentScope ? null : props.serverId);
    const accountScope = currentScope ?? (binding?.isCurrent() ? binding.scope : null);
    const reachabilityRevision = useMachineReachabilityRevision();
    const [sources, setSources] = React.useState<readonly SessionFollowSourceV1[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [savingId, setSavingId] = React.useState<string | null>(null);
    const [openSourceId, setOpenSourceId] = React.useState<string | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [mutation, dispatchMutation] = React.useReducer(
        reduceSourceMutation,
        createIdleSessionFollowMutationIntent<SessionFollowSourceIntent>(),
    );
    const [preparedSourceKeys, setPreparedSourceKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const [preparingFlightKeys, setPreparingFlightKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const [preparationWaitingReasons, setPreparationWaitingReasons] = React.useState<ReadonlyMap<string, SessionFollowSourceKeyPreparationWaitingReasonV1>>(() => new Map());
    const addSourceRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    // The pane's "+" is an IconButton, which hands out its control through a callback ref.
    const paneAddRef = React.useRef<Readonly<{ focus: () => void }> | null>(null);
    const readFlightRef = React.useRef<{ readonly targetKey: string; settled: Promise<void>; dirty: boolean } | null>(null);
    const targetKey = `${props.serverId ?? ''}\u0000${accountScope?.accountId ?? ''}\u0000${props.destination.id}`;
    const preparationTargetKey = `${targetKey}\u0000${props.destinationMachineId ?? ''}`;
    const targetKeyRef = React.useRef(targetKey);
    const preparationTargetKeyRef = React.useRef(preparationTargetKey);
    const activeMutationRequestRef = React.useRef<SessionFollowSourceMutationRequest | null>(null);
    const preparationInFlightRef = React.useRef(new Map<string, { sourceSessionId: string; controller: AbortController }>());
    const committedSourceIdsRef = React.useRef<ReadonlySet<string>>(new Set());
    const edgeVersionBySourceIdRef = React.useRef(new Map<string, number>());

    const readSources = React.useCallback(async (serverId: string) => {
        setLoading(true);
        const result = await listSessionFollowSources({ serverId, sessionId: props.destination.id });
        if (targetKeyRef.current !== targetKey) return;
        if (result.kind === 'ok') {
            // This list draws Session sources; the Home's other source kinds share the read and are not rows here yet.
            const sessionSources = result.value.sources.filter((source): source is SessionFollowSourceV1 => 'sourceSessionId' in source);
            const committedSourceIds = new Set(sessionSources.map((source) => source.sourceSessionId));
            const previousCommittedSourceIds = committedSourceIdsRef.current;
            for (const sourceSessionId of new Set([
                ...previousCommittedSourceIds,
                ...committedSourceIds,
            ])) {
                if (previousCommittedSourceIds.has(sourceSessionId) !== committedSourceIds.has(sourceSessionId)) {
                    for (const [key, request] of preparationInFlightRef.current) {
                        if (request.sourceSessionId === sourceSessionId) {
                            request.controller.abort();
                            preparationInFlightRef.current.delete(key);
                        }
                    }
                    edgeVersionBySourceIdRef.current.set(
                        sourceSessionId,
                        (edgeVersionBySourceIdRef.current.get(sourceSessionId) ?? 0) + 1,
                    );
                }
            }
            committedSourceIdsRef.current = committedSourceIds;
            setPreparingFlightKeys(current => new Set([...current].filter(key => preparationInFlightRef.current.has(key))));
            const committedPreparationKeys = new Set([...committedSourceIds].map((sourceSessionId) => (
                sourcePreparationKey(preparationTargetKeyRef.current, sourceSessionId)
            )));
            setSources(sessionSources);
            setPreparedSourceKeys((current) => {
                const next = new Set([...current].filter((key) => committedPreparationKeys.has(key)));
                return next.size === current.size ? current : next;
            });
            setPreparationWaitingReasons((current) => {
                const next = new Map([...current].filter(([key]) => committedPreparationKeys.has(key)));
                return next.size === current.size ? current : next;
            });
            setFailed(false);
            dispatchMutation({ kind: 'refreshed' });
        } else {
            setFailed(true);
        }
        setLoading(false);
    }, [props.destination.id, targetKey]);

    // One read per destination at a time. A Home wake or a finished write that arrives while a read is in
    // flight marks it dirty and earns one follow-up read; it never discards the read in progress, so a busy
    // Home that wakes faster than it answers cannot leave the list loading forever.
    const refresh = React.useCallback((): Promise<void> => {
        const serverId = props.serverId;
        if (!enabled || !serverId) return Promise.resolve();
        const running = readFlightRef.current;
        if (running && running.targetKey === targetKey) {
            running.dirty = true;
            return running.settled;
        }
        const flight: NonNullable<typeof readFlightRef.current> = { targetKey, dirty: false, settled: Promise.resolve() };
        flight.settled = (async () => {
            try {
                do {
                    flight.dirty = false;
                    await readSources(serverId);
                } while (flight.dirty && targetKeyRef.current === targetKey);
            } finally {
                if (readFlightRef.current === flight) readFlightRef.current = null;
            }
        })();
        readFlightRef.current = flight;
        return flight.settled;
    }, [enabled, props.serverId, readSources, targetKey]);

    React.useEffect(() => {
        if (targetKeyRef.current !== targetKey) {
            targetKeyRef.current = targetKey;
            setSources([]);
            setFailed(false);
            dispatchMutation({ kind: 'abandoned' });
            setSavingId(null);
            activeMutationRequestRef.current = null;
            setPreparedSourceKeys(new Set());
            setPreparingFlightKeys(new Set());
            setPreparationWaitingReasons(new Map());
            committedSourceIdsRef.current = new Set();
            edgeVersionBySourceIdRef.current = new Map();
        }
        void refresh();
    }, [refresh, targetKey]);

    React.useEffect(() => () => {
        activeMutationRequestRef.current = null;
    }, []);

    React.useEffect(() => {
        if (preparationTargetKeyRef.current === preparationTargetKey) return;
        preparationTargetKeyRef.current = preparationTargetKey;
        activeMutationRequestRef.current = null;
        setSavingId(null);
        setPreparedSourceKeys(new Set());
        setPreparingFlightKeys(new Set());
        setPreparationWaitingReasons(new Map());
    }, [preparationTargetKey]);

    React.useEffect(() => () => {
        for (const request of preparationInFlightRef.current.values()) request.controller.abort();
        preparationInFlightRef.current.clear();
    }, [preparationTargetKey]);

    React.useEffect(() => {
        const serverId = props.serverId;
        if (!enabled || !serverId) return;
        return subscribeHomeAccountChange((event) => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
            if (
                event.entityIds
                && !event.entityIds.includes(props.destination.id)
                && !event.entityIds.some((sessionId) => committedSourceIdsRef.current.has(sessionId))
            ) return;
            void refresh();
        });
    }, [enabled, props.destination.id, props.serverId, refresh]);

    const remove = React.useCallback(async (sourceSessionId: string) => {
        if (!online || !props.serverId || savingId) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceSessionId,
        };
        activeMutationRequestRef.current = request;
        setSavingId(sourceSessionId);
        dispatchMutation({ kind: 'started', intent: { kind: 'remove', sourceSessionId } });
        const input = { serverId: props.serverId, destinationSessionId: props.destination.id, sourceSessionId };
        const result = await removeSessionFollowSource(input);
        if (
            preparationTargetKeyRef.current !== request.targetKey
            || activeMutationRequestRef.current !== request
        ) return;
        if (result.kind === 'ok') {
            dispatchMutation({ kind: 'succeeded' });
            await refresh();
            if (
                preparationTargetKeyRef.current !== request.targetKey
                || activeMutationRequestRef.current !== request
            ) return;
            // Its panel has nothing left to edit: close it, or leave the page that held it.
            setOpenSourceId(null);
            if (props.page) props.page.onClose();
            else (addSourceRef.current ?? paneAddRef.current)?.focus();
        }
        else dispatchMutation({ kind: 'failed', error: true });
        activeMutationRequestRef.current = null;
        setSavingId(null);
    }, [online, preparationTargetKey, props.destination.id, props.page, props.serverId, refresh, savingId]);

    const updatePolicy = React.useCallback(async (sourceSessionId: string, policy: FollowPolicyV1) => {
        if (!online || !props.serverId || savingId) return;
        const request: SessionFollowSourceMutationRequest = {
            targetKey: preparationTargetKey,
            sourceSessionId,
        };
        activeMutationRequestRef.current = request;
        setSavingId(sourceSessionId);
        dispatchMutation({ kind: 'started', intent: { kind: 'policy', sourceSessionId, policy } });
        const result = await setSessionFollowSource({
            serverId: props.serverId,
            destinationSessionId: props.destination.id,
            sourceSessionId,
            policy,
        });
        if (
            preparationTargetKeyRef.current !== request.targetKey
            || activeMutationRequestRef.current !== request
        ) return;
        if (result.kind === 'ok') {
            dispatchMutation({ kind: 'succeeded' });
            await refresh();
            if (
                preparationTargetKeyRef.current !== request.targetKey
                || activeMutationRequestRef.current !== request
            ) return;
        }
        else dispatchMutation({ kind: 'failed', error: true });
        activeMutationRequestRef.current = null;
        setSavingId(null);
    }, [online, preparationTargetKey, props.destination.id, props.serverId, refresh, savingId]);

    const serverId = props.serverId;
    const homeSessions = Object.values(readSessionListRowsForServerId(rowsByServerId, serverId ?? '') ?? {});
    // Exact qualified Machine currentness belongs to the canonical scoped
    // selector. The picker-oriented Machine list intentionally filters records
    // and is not an authority for an already-bound destination Runner.
    const destinationMachine = useServerScopedMachine(serverId, props.destinationMachineId ?? '');
    const nowMs = useMachinePresenceNowMs(destinationMachine ? [destinationMachine] : []);
    const destinationPresence = destinationMachine
        ? resolveMachinePickerPresence(destinationMachine, nowMs, accountScope).status
        : null;
    const canPrepareSource = accountScope !== null && destinationMachine !== null
        && destinationMachine.availability?.kind !== 'locked'
        && destinationPresence !== 'revoked' && destinationPresence !== 'replaced';
    const destinationReachable = destinationMachine !== null && isMachineReachable(accountScope, destinationMachine, nowMs);

    const prepareSource = React.useCallback(async (sourceSessionId: string, intent?: 'retry') => {
        if (!canPrepareSource || !props.serverId) return;
        const requestTargetKey = targetKey;
        const requestPreparationTargetKey = preparationTargetKey;
        const requestEdgeVersion = edgeVersionBySourceIdRef.current.get(sourceSessionId) ?? 0;
        const preparationSourceKey = sourcePreparationKey(requestPreparationTargetKey, sourceSessionId);
        const flightKey = `${preparationSourceKey}\u0000${requestEdgeVersion}`;
        if (preparationInFlightRef.current.has(flightKey)) return;
        const request = { sourceSessionId, controller: new AbortController() };
        preparationInFlightRef.current.set(flightKey, request);
        setPreparingFlightKeys((current) => new Set(current).add(flightKey));
        const result = await prepareSessionFollowSourceKey({
            serverId: props.serverId, sourceSessionId, destinationSessionId: props.destination.id,
            ...(intent ? { intent } : {}),
            signal: request.controller.signal,
        }).catch(() => ({ kind: 'waiting', reason: 'runner_unreachable' } as const));
        if (preparationInFlightRef.current.get(flightKey) !== request) return;
        preparationInFlightRef.current.delete(flightKey);
        if (
            targetKeyRef.current !== requestTargetKey
            || preparationTargetKeyRef.current !== requestPreparationTargetKey
            || request.controller.signal.aborted
        ) return;
        setPreparingFlightKeys((current) => {
            const next = new Set(current);
            next.delete(flightKey);
            return next;
        });
        // A receiver result cannot establish readiness for an edge that was
        // removed while the request was in flight. The server remains the
        // pairwise authority; this prevents stale UI-lifetime state from
        // suppressing preparation if the same relation is later re-created.
        if (!committedSourceIdsRef.current.has(sourceSessionId)
            || edgeVersionBySourceIdRef.current.get(sourceSessionId) !== requestEdgeVersion) return;
        setPreparedSourceKeys((current) => {
            const next = new Set(current);
            if (result.kind === 'prepared' || result.kind === 'not_needed') next.add(preparationSourceKey);
            else next.delete(preparationSourceKey);
            return next;
        });
        setPreparationWaitingReasons((current) => {
            const next = new Map(current);
            if (result.kind === 'waiting') next.set(preparationSourceKey, result.reason);
            else next.delete(preparationSourceKey);
            return next;
        });
    }, [canPrepareSource, preparationTargetKey, props.destination.id, props.serverId, targetKey]);

    const preparationReadinessSignature = [
        targetKey,
        online ? 'online' : 'offline',
        destinationReachable ? 'reachable' : 'unreachable',
        props.destinationMachineId ?? '',
        destinationMachine?.active === true ? 'active' : 'inactive',
        String(destinationMachine?.activeAt ?? ''),
        String(destinationMachine?.operationProtocolCapabilitiesRevision ?? ''),
        ...sources.map((source) => {
            const session = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
            return `${source.sourceSessionId}:${source.deliveryState}:${session?.encryptionMode ?? 'unknown'}`;
        }),
    ].join('\u0000');
    const lastPreparationReadinessSignatureRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (lastPreparationReadinessSignatureRef.current === preparationReadinessSignature) return;
        lastPreparationReadinessSignatureRef.current = preparationReadinessSignature;
        if (!online || !destinationReachable) return;
        for (const source of sources) {
            const sourceSession = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
            const runtimeState = resolveSessionFollowSourceRuntimeState({
                accountScope,
                nowMs,
                deliveryState: source.deliveryState,
                machine: destinationMachine,
                sourceEncryptionMode: sourceSession?.encryptionMode ?? null,
                preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
                hasPendingUpdates: source.hasPendingUpdates,
            });
            const flightKey = `${sourcePreparationKey(preparationTargetKey, source.sourceSessionId)}\u0000${edgeVersionBySourceIdRef.current.get(source.sourceSessionId) ?? 0}`;
            if (runtimeState === 'waiting_for_source_key' && !preparingFlightKeys.has(flightKey)) {
                void prepareSource(source.sourceSessionId);
            }
        }
    }, [destinationMachine, destinationReachable, homeSessions, online, preparationReadinessSignature, preparationTargetKey, prepareSource, preparedSourceKeys, preparingFlightKeys, sources, accountScope, nowMs, reachabilityRevision]);

    if (!enabled || !serverId) return null;

    const addSource = () => openSessionFollowSourcePicker({
        serverId,
        sessionId: props.destination.id,
    }, pane ? paneAddRef : addSourceRef, async (change) => {
        if (change?.preparation === 'prepared') {
            const preparationSourceKey = sourcePreparationKey(preparationTargetKey, change.sourceSessionId);
            setPreparedSourceKeys((current) => new Set(current).add(preparationSourceKey));
            setPreparationWaitingReasons((current) => {
                const next = new Map(current);
                next.delete(preparationSourceKey);
                return next;
            });
        } else if (change?.preparation === 'waiting') {
            const preparationSourceKey = sourcePreparationKey(preparationTargetKey, change.sourceSessionId);
            setPreparedSourceKeys((current) => {
                const next = new Set(current);
                next.delete(preparationSourceKey);
                return next;
            });
            // Store the reason the preparation actually returned. Inventing
            // `source_key_unavailable` here made an unreachable Runner and an
            // unsupported destination read as a source-key problem.
            setPreparationWaitingReasons((current) => {
                const next = new Map(current);
                if (change.reason === undefined) next.delete(preparationSourceKey);
                else next.set(preparationSourceKey, change.reason);
                return next;
            });
        }
        await refresh();
    });

    const sourceIdentity = (source: SessionFollowSourceV1) => {
        const session = homeSessions.find((candidate) => candidate.id === source.sourceSessionId);
        return { session, sourceTitle: session ? getSessionName(session, serverId) : source.sourceSessionId };
    };
    const policyDisabled = !online || savingId !== null;
    // A panel is open while its source is still listed; a mutation error belongs to that panel then, not to the list.
    const panelOpen = anchored && sources.some((source) => source.sourceSessionId === openSourceId);
    const closePanel = () => {
        setOpenSourceId(null);
        props.page?.onClose();
    };
    // Retry re-executes the exact operation that failed; only a failed list load retries by loading the list again.
    const retryFailed = () => {
        const intent = mutation.failed;
        if (!intent) { void refresh(); return; }
        if (intent.kind === 'remove') { void remove(intent.sourceSessionId); return; }
        void updatePolicy(intent.sourceSessionId, intent.policy);
    };
    const errorRow = (look: typeof rowLook | Record<string, never>) => <Item
        {...look}
        testID="session-follow-sources-error"
        title={t('errors.unknownError')}
        detail={t('common.retry')}
        accessibilityLiveRegion="polite"
        onPress={retryFailed}
    />;

    // One source's panel (lab P2-S): who it hears from and how much, Stop updates quiet at the left, Done.
    const panelPartsFor = (source: SessionFollowSourceV1): FollowSourcePanelParts => {
        const { session, sourceTitle } = sourceIdentity(source);
        const draft = mutation.pending ?? mutation.failed;
        const policy = draft?.kind === 'policy' && draft.sourceSessionId === source.sourceSessionId
            ? draft.policy : source.policy;
        return {
            title: t('session.follow.sources.row', { title: sourceTitle }),
            subtitle: t('session.follow.sources.panelSubtitle'),
            mark: <FollowSessionMark metadata={session?.metadata} serverId={serverId} />,
            body: <>
                {mutation.error !== null ? <ItemGroup>{errorRow({})}</ItemGroup> : null}
                <FollowPolicySection>
                    <FollowPolicyEditorBinding
                        testID={`session-follow-source-${source.sourceSessionId}-policy`}
                        receiver="session"
                        model={projectFollowPolicyEditorV1(policy)}
                        disabled={policyDisabled}
                        onEditPolicy={(edit) => { void updatePolicy(source.sourceSessionId, editFollowPolicyV1(policy, edit)); }}
                    />
                </FollowPolicySection>
            </>,
            footer: <SectionButtonRow
                trailing={<RoundButton testID={`session-follow-source-${source.sourceSessionId}-done`} title={t('common.done')} onPress={closePanel} />}
            >
                <RoundButton
                    testID={`session-follow-source-${source.sourceSessionId}-remove`}
                    display="inverted"
                    title={t('session.follow.sources.stop')}
                    accessibilityLabel={t('session.follow.sources.stopForSource', { title: sourceTitle })}
                    disabled={policyDisabled}
                    onPress={() => { void remove(source.sourceSessionId); }}
                />
            </SectionButtonRow>,
        };
    };

    // A wide window anchors the panel to the row; a phone pushes the page, which mounts this editor for that source.
    const openSource = (sourceSessionId: string) => {
        if (anchored) { setOpenSourceId(sourceSessionId); return; }
        router.push(buildScopedSessionRouteHref({
            sessionId: props.destination.id,
            serverId,
            suffix: '/follow-source',
            query: { source: sourceSessionId },
        }) as Href);
    };

    if (props.page) {
        const source = sources.find((candidate) => candidate.sourceSessionId === props.page?.sourceSessionId);
        if (!source) return loading ? <Item title={t('common.loading')} loading showChevron={false} mode="info" /> : null;
        return <>{props.page.frame(panelPartsFor(source))}</>;
    }

    const sourceRows = <>
            {!online ? <Item
                {...rowLook}
                testID="session-follow-sources-offline"
                title={t('session.follow.offline')}
                accessibilityLiveRegion="polite"
                titleLines={0}
                showChevron={false}
                mode="info"
            /> : null}
            {loading && sources.length === 0 ? <Item {...rowLook} title={t('common.loading')} loading showChevron={false} mode="info" /> : null}
            {!loading && sources.length === 0 && !failed ? (pane
                ? <View style={styles.paneEmpty}><EmptyState testID="session-follow-sources-empty" layout="line" title={t('session.follow.sources.empty')} /></View>
                : <Item {...rowLook} testID="session-follow-sources-empty" title={t('session.follow.sources.empty')} showChevron={false} mode="info" />) : null}
            {sources.map((source) => {
                const { session, sourceTitle } = sourceIdentity(source);
                const runtimeState = resolveSessionFollowSourceRuntimeState({
                    accountScope,
                    nowMs,
                    deliveryState: source.deliveryState,
                    machine: destinationMachine,
                    sourceEncryptionMode: session?.encryptionMode ?? null,
                    preparedInUiLifetime: preparedSourceKeys.has(sourcePreparationKey(preparationTargetKey, source.sourceSessionId)),
                    hasPendingUpdates: source.hasPendingUpdates,
                });
                const preparationSourceKey = sourcePreparationKey(preparationTargetKey, source.sourceSessionId);
                const currentFlightKey = `${preparationSourceKey}\u0000${edgeVersionBySourceIdRef.current.get(source.sourceSessionId) ?? 0}`;
                const preparing = preparingFlightKeys.has(currentFlightKey);
                const preparationWaitingReason = preparationWaitingReasons.get(preparationSourceKey);
                const presentedRuntimeState = refineSessionFollowSourceStateWithPreparationReason(runtimeState, preparationWaitingReason);
                // An unavailable SOURCE key can still become available (the Session is unlocked
                // in this client), so it keeps its retry; only an unavailable Runner key cannot.
                const canRetryPreparation = presentedRuntimeState === 'waiting_for_source_key'
                    || presentedRuntimeState === 'waiting_for_runtime'
                    || presentedRuntimeState === 'source_key_unavailable'
                    || preparationWaitingReason === 'runner_unreachable';
                const statusText = presentedRuntimeState === 'eligible'
                    ? (pane ? describeSessionFollowLevel(source.policy.preset) : t(`session.follow.policy.${source.policy.preset}`))
                    : sessionFollowSourceRuntimeStateLabel(presentedRuntimeState);
                const open = panelOpen && openSourceId === source.sourceSessionId;
                return <SourceRowAnchor
                    key={source.sourceSessionId}
                    row={(triggerRef) => <Item
                        {...rowLook}
                        {...(pane ? { icon: <Icon name="stack" size={18} color={theme.colors.text.secondary} /> } : {})}
                        pressableRef={triggerRef}
                        testID={`session-follow-source-${source.sourceSessionId}`}
                        accessibilityLabel={[
                            t('session.follow.sources.row', { title: sourceTitle }),
                            statusText,
                        ].join('. ')}
                        title={pane ? sourceTitle : t('session.follow.sources.row', { title: sourceTitle })}
                        titleLines={0}
                        subtitle={preparing ? t('session.follow.sources.sourceKeyPreparing') : statusText}
                        subtitleLines={0}
                        accessoryLayout="adaptive"
                        onPress={() => openSource(source.sourceSessionId)}
                        rightElementOutsidePressable
                        keepChevronWithRightElement
                        rightElement={canRetryPreparation ? <RoundButton
                            testID={`session-follow-source-${source.sourceSessionId}-retry`}
                            title={t('common.retry')}
                            size="small"
                            display="secondary"
                            accessibilityLabel={`${t('common.retry')}. ${t('session.follow.sources.row', { title: sourceTitle })}`}
                            disabled={!canPrepareSource || savingId !== null || preparing}
                            onPress={() => { void prepareSource(source.sourceSessionId, 'retry'); }}
                        /> : undefined}
                    />}
                    panel={open ? ({ anchorRef, triggerRef }) => {
                        const parts = panelPartsFor(source);
                        return <FollowEditorPanel anchorRef={anchorRef} focusReturnRef={triggerRef} onRequestClose={closePanel}
                            testID={`session-follow-source-${source.sourceSessionId}-panel`}
                            accessibilityLabel={parts.title}
                            title={parts.title} subtitle={parts.subtitle} mark={parts.mark} footer={parts.footer}>
                            {parts.body}
                        </FollowEditorPanel>;
                    } : null}
                />;
            })}
            {failed || (mutation.error !== null && !panelOpen) ? errorRow(rowLook) : null}
    </>;

    if (pane) {
        return <View testID="session-follow-sources-pane" style={styles.paneSection}>
            <PaneSectionHeader
                title={t('session.follow.sources.title')}
                count={!failed && sources.length > 0 ? sources.length : undefined}
                action={<IconButton
                    controlRef={(node) => { paneAddRef.current = node; }}
                    testID="session-follow-source-add"
                    iconName="plus"
                    size={28}
                    iconSize={15}
                    variant="plain"
                    accessibilityLabel={t('session.follow.sources.addSource')}
                    tooltip={t('session.follow.sources.addSource')}
                    disabled={!online || savingId !== null}
                    onPress={addSource}
                />}
            />
            {sourceRows}
        </View>;
    }

    return <>
        <ItemGroup title={t('session.follow.sources.title')}>
            {sourceRows}
        </ItemGroup>
        <ItemGroup title={t('common.add')}>
            <Item
                pressableRef={addSourceRef}
                testID="session-follow-source-add"
                title={t('session.follow.sources.addSource')}
                subtitle={t('session.follow.sources.includeNextTurn')}
                disabled={!online || savingId !== null}
                onPress={addSource}
            />
        </ItemGroup>
    </>;
}

const styles = StyleSheet.create((theme) => ({
    paneSection: { paddingTop: theme.space.s12 },
    // The line starts where the section heading's text does.
    paneEmpty: { paddingLeft: theme.space.s8 },
}));
