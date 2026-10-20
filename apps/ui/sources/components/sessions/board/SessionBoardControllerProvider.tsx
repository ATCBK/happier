import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import {
    createSessionBoardActionsPort,
    type SessionBoardActionsPort,
    type SessionBoardMountHost,
    type SessionBoardPrimaryMountResolver,
} from '@/sync/domains/session/board';
import { useAuth } from '@/auth/context/AuthContext';
import { openAccountSecurityForHome } from '@/components/settings/account/openAccountSecurityForHome';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { openRouteWithEstablishedHome } from '@/sync/domains/server/selection/openRouteWithEstablishedHome';
import { useSessionBoardFeatureEnabled } from './useSessionBoardFeatureEnabled';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { FocusReturnRef, FocusReturnTarget } from '@/keyboard/focusReturn';
import { useSessionPluginRuntime } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionPluginPolicyContext } from '@/components/sessions/plugins/useSessionPluginPolicyContext';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { useSessionCallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/useSessionCallerHostedHtmlRuntime';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useSessionBoardComposerSuggestion } from './useSessionBoardComposerSuggestion';

import {
    SessionBoardContinuityProvider,
    useSessionBoardContinuity,
} from './SessionBoardContinuity';
import {
    createSessionBoardSourceAvailabilityResolver,
} from './sessionBoardItemPresentation';
import { useSessionBoardSnapshot } from './useSessionBoardSnapshot';
import {
    useSessionBoardController,
    type SessionBoardController,
    type SessionBoardControllerInput,
} from './useSessionBoardController';
import { showSessionBoardViewRemovalDisposition } from './showSessionBoardViewRemovalDisposition';
import {
    selectCurrentSessionWidgetCandidates,
    type WidgetCandidate,
} from '@/components/widgets/widgetCatalog';
import type { SessionBoardBinding } from './observeSessionBoard';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSessionBoardMutationApproval } from './sessionBoardMutationApproval';
import type { SessionBoardBodyEligibilityReporter, SessionBoardPlacementPrimaryMountResolver } from './sessionBoardHostVisibility';

export type MountedSessionBoardController = Readonly<{
    address: SessionAddress;
    controller: SessionBoardController;
    binding: SessionBoardBinding & Readonly<{ refresh?: () => void }>;
    actions: SessionBoardActionsPort;
    approvalPending: boolean;
    requestApprovalContinuation?: ReturnType<typeof useSessionBoardMutationApproval>['request'];
    pluginRuntime: SessionPluginRuntimeState;
    callerHostedHtmlRuntime: CallerHostedHtmlRuntime | null;
    /** One exact-session policy selection shared by Add visibility and picker rows. */
    installedWidgetCandidates: readonly WidgetCandidate[];
    /** Actual open Board/Companion inventory consumers share this content demand. */
    acquireContent?: () => () => void;
    /**
     * The Session shell's OWN derived executable placement, carried for hosts that
     * are too deep in the tree to receive it as a prop — today, the inline
     * transcript reference. This is transport for the one shell composition's
     * result, not a second arbiter: nothing here stores, leases or decides it, and
     * a shell that publishes none answers `null`, which every host reads as "this
     * placement does not run the item".
     *
     * The owner adds selected-view membership and each Surface's measured body
     * eligibility, so a host outside the Board (the Companion rail) is never told
     * that a Board tab runs an item whose body that tab does not build.
     */
    resolvePrimaryHost: SessionBoardPlacementPrimaryMountResolver;
    /** Measured body eligibility from each generic surface; the shell still chooses the host. */
    onBodyEligibilityChange: SessionBoardBodyEligibilityReporter;
    /**
     * A transcript reply drawing an executable item reports while the transcript list's own
     * visibility owner demands its content; the returned function withdraws it. This is a physical
     * fact like body eligibility, never a host decision: the shell resolver still ranks the
     * transcript after every Board host.
     */
    reportInlineTranscriptDemand: (itemId: string, occurrence: string) => () => void;
    /**
     * Which demanded reply runs the item when the transcript is its host: the reply that has been
     * on screen longest, so a body never jumps between replies while the person reads.
     */
    resolveInlineTranscriptOccurrence: (itemId: string) => string | null;
    /**
     * "Show here": the person (or an Agent, through `chat.return` with a widgetId) asked this item to
     * run in its transcript reply. With an occurrence, that exact reply takes the body; without one
     * the reply that has been on screen longest does. Every Board host then previews it.
     */
    showInlineTranscriptItem: (itemId: string, occurrence?: string) => 'applied' | 'unchanged' | 'unavailable';
    /** Opening the item on a Board host takes the request back: the latest explicit choice wins. */
    releaseInlineTranscriptItem: (itemId: string) => void;
    /** Registers the real workspace tab hosts consumed by Board removal dialogs. */
    onViewFocusTargetChange: (viewId: string, target: FocusReturnTarget) => void;
    /** Registers the workspace's surviving Board-view action control fallback. */
    onViewActionsFocusTargetChange: (target: FocusReturnTarget) => void;
    /** Absent for direct/test owners that register no workspace action control. */
    viewActionsFocusTargetRef?: FocusReturnRef;
}>;

const NO_PRIMARY_MOUNT: SessionBoardPrimaryMountResolver = () => null;
const NO_INSTALLED_WIDGET_CANDIDATES: readonly WidgetCandidate[] = Object.freeze([]);
const NO_INLINE_TRANSCRIPT_DEMAND: ReadonlyMap<string, readonly string[]> = new Map();
const NO_INLINE_TRANSCRIPT_PREFERENCE: ReadonlySet<string> = new Set();

const SessionBoardControllerContext = React.createContext<MountedSessionBoardController | null>(null);

function SessionBoardWidgetCandidateSelection(props: Readonly<{
    session: Session | null;
    runtime: SessionPluginRuntimeState;
    boardFeatureEnabled: boolean;
    canEdit: boolean;
    hostedHtmlRendererAvailable: boolean;
    children: (selection: Readonly<{
        candidates: readonly WidgetCandidate[];
        resolveSourceAvailability: ReturnType<typeof createSessionBoardSourceAvailabilityResolver>;
    }>) => React.ReactElement;
}>): React.ReactElement {
    if (!props.session) return props.children({
        candidates: NO_INSTALLED_WIDGET_CANDIDATES,
        resolveSourceAvailability: createSessionBoardSourceAvailabilityResolver({
            hostedHtmlRendererAvailable: props.hostedHtmlRendererAvailable,
        }),
    });
    return (
        <SessionBoardWidgetCandidateSelectionReady
            session={props.session}
            runtime={props.runtime}
            boardFeatureEnabled={props.boardFeatureEnabled}
            canEdit={props.canEdit}
            hostedHtmlRendererAvailable={props.hostedHtmlRendererAvailable}
        >
            {props.children}
        </SessionBoardWidgetCandidateSelectionReady>
    );
}

function SessionBoardWidgetCandidateSelectionReady(props: Readonly<{
    session: Session;
    runtime: SessionPluginRuntimeState;
    boardFeatureEnabled: boolean;
    canEdit: boolean;
    hostedHtmlRendererAvailable: boolean;
    children: (selection: Readonly<{
        candidates: readonly WidgetCandidate[];
        resolveSourceAvailability: ReturnType<typeof createSessionBoardSourceAvailabilityResolver>;
    }>) => React.ReactElement;
}>): React.ReactElement {
    const policyContext = useSessionPluginPolicyContext({
        session: props.session,
        runtime: props.runtime,
    });
    const candidates = React.useMemo(
        () => selectCurrentSessionWidgetCandidates({
            runtime: props.runtime,
            boardFeatureEnabled: props.boardFeatureEnabled,
            canEdit: props.canEdit,
            policyContext,
        }),
        [policyContext, props.boardFeatureEnabled, props.canEdit, props.runtime],
    );
    const resolveSourceAvailability = React.useMemo(
        () => createSessionBoardSourceAvailabilityResolver({
            hostedHtmlRendererAvailable: props.hostedHtmlRendererAvailable,
        }),
        [props.hostedHtmlRendererAvailable],
    );
    return props.children({ candidates, resolveSourceAvailability });
}

/**
 * Mount the one viewer-local Board controller for an exact Session shell.
 *
 * Board panes are projections of this owner. They never construct controllers,
 * snapshots, CAS/recovery refs, draft state, or active-view state themselves.
 * Nothing here is global or persisted: removing this exact Session shell drops
 * its local presentation state naturally.
 */
export function SessionBoardControllerProvider(props: React.PropsWithChildren<Readonly<{
    sessionId: string;
    serverId?: string | null;
    /**
     * The exact Session shell may already own the plugin runtime so its pane
     * driver, Board, Companion, and full-screen surfaces all observe the same
     * projection instance. Direct/test hosts may omit it and resolve here.
     */
    pluginRuntime?: SessionPluginRuntimeState;
    /**
     * The shell's already-derived executable placement, when this mount site is a
     * Session shell that computed one. Omitted by hosts whose placement facts live
     * below the provider (the mobile Cockpit resolves per surface), and those
     * simply publish no executable placement to deep consumers.
     */
    resolvePrimaryHost?: SessionBoardPlacementPrimaryMountResolver;
}>>): React.ReactElement {
    const existingOwner = React.useContext(SessionBoardControllerContext);
    const address = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? null, props.sessionId),
        [props.serverId, props.sessionId],
    );
    if (!address) return <>{props.children}</>;
    if (existingOwner && sessionAddressKey(existingOwner.address) === sessionAddressKey(address)) {
        return <>{props.children}</>;
    }

    const addressKey = sessionAddressKey(address);
    const content = (
        <SessionBoardContinuityProvider
            key={addressKey}
            sessionId={address.sessionId}
            serverId={address.serverId}
        >
            <SessionBoardControllerRuntimeOwner
                address={address}
                pluginRuntime={props.pluginRuntime}
                resolvePrimaryHost={props.resolvePrimaryHost}
            >
                {props.children}
            </SessionBoardControllerRuntimeOwner>
        </SessionBoardContinuityProvider>
    );
    return content;
}

function SessionBoardControllerRuntimeOwner(props: React.PropsWithChildren<Readonly<{
    address: SessionAddress;
    pluginRuntime?: SessionPluginRuntimeState;
    resolvePrimaryHost?: SessionBoardPlacementPrimaryMountResolver;
}>>): React.ReactElement {
    const boardFeatureEnabled = useSessionBoardFeatureEnabled(props.address.serverId);
    const [contentDemand, setContentDemand] = React.useState(0);
    const acquireContent = React.useCallback(() => {
        setContentDemand(value => value + 1);
        return () => setContentDemand(value => value - 1);
    }, []);
    const binding = useSessionBoardSnapshot({
        serverId: props.address.serverId,
        sessionId: props.address.sessionId,
        boardFeatureEnabled,
        demanded: contentDemand > 0,
    });
    const actions = React.useMemo<SessionBoardActionsPort>(
        () => createSessionBoardActionsPort(props.address),
        [props.address],
    );
    const approval = useSessionBoardMutationApproval({
        address: props.address,
        onExecuted: binding.refresh,
    });
    const resolvedPluginRuntime = useSessionPluginRuntime({
        address: props.pluginRuntime ? null : props.address,
    });
    const pluginRuntime = props.pluginRuntime ?? resolvedPluginRuntime;
    const session = useSessionViewShellSession(props.address.sessionId, props.address.serverId);
    const callerHostedHtmlRuntime = useSessionCallerHostedHtmlRuntime(
        props.address.serverId,
        props.address.sessionId,
        pluginRuntime,
    );
    const viewFocusTargetsRef = React.useRef(new Map<string, FocusReturnTarget>());
    const viewActionsFocusTargetRef = React.useRef<FocusReturnTarget>(null);
    const onViewFocusTargetChange = React.useCallback((viewId: string, target: FocusReturnTarget) => {
        if (target == null) viewFocusTargetsRef.current.delete(viewId);
        else viewFocusTargetsRef.current.set(viewId, target);
    }, []);
    const onViewActionsFocusTargetChange = React.useCallback((target: FocusReturnTarget) => {
        viewActionsFocusTargetRef.current = target;
    }, []);
    const focusReturnRefForView = React.useCallback((viewId: string): FocusReturnRef => ({
        get current() {
            return viewFocusTargetsRef.current.get(viewId) ?? viewActionsFocusTargetRef.current;
        },
    }), []);
    const promptViewTitle = React.useCallback(async (request: Readonly<{
        title: string;
        defaultValue?: string;
    }>): Promise<string | null> => await Modal.prompt(request.title, undefined, {
        ...(request.defaultValue === undefined ? {} : { defaultValue: request.defaultValue }),
        confirmText: t('common.save'),
        cancelText: t('common.cancel'),
    }), []);
    const chooseViewRemovalDisposition = React.useCallback((request: Parameters<
        typeof showSessionBoardViewRemovalDisposition
    >[0]) => showSessionBoardViewRemovalDisposition(
        request,
        focusReturnRefForView(request.source.viewId),
    ), [focusReturnRefForView]);
    const continuity = useSessionBoardContinuity(props.address);

    // Recovery navigation belongs to the controller, not to a placement.
    //
    // Every Board host renders the same typed unavailable states, and the Board's
    // OWN locked layout card asks `controller.supports('item.prepareEncryption')`
    // for its action. While these handlers lived in `SessionBoardPane`, that
    // question was permanently `false` in production: a locked shared layout drew
    // a recovery card with no way out, even though the identical per-item card in
    // the same surface had a working handler. One owner, one answer, every host.
    const router = useRouter();
    const auth = useAuth();
    const presentRecoveryNavigationError = React.useCallback(() => {
        Modal.alert(t('common.error'), t('errors.unknownError'));
    }, []);
    const openRecoveryRoute = React.useCallback(async (navigate: () => void): Promise<void> => {
        try {
            const result = await openRouteWithEstablishedHome({
                serverId: props.address.serverId,
                refreshAuth: auth.refreshFromActiveServer,
                navigate,
            });
            if (result === 'blocked') presentRecoveryNavigationError();
        } catch {
            presentRecoveryNavigationError();
        }
    }, [auth.refreshFromActiveServer, presentRecoveryNavigationError, props.address.serverId]);
    const bindingRef = React.useRef(binding);
    bindingRef.current = binding;
    const managePluginForItem = React.useCallback(async (itemId: string): Promise<void> => {
        const current = bindingRef.current;
        const projected = current.status === 'ready' ? current.snapshot.itemsById.get(itemId) : null;
        if (projected?.state.kind !== 'ready') return;
        const source = projected.state.item.source;
        if (source.kind !== 'widget' || source.instance.definition.kind !== 'installed') return;
        const pluginId = source.instance.definition.surface.pluginId;
        await openRecoveryRoute(() => { router.push(buildPluginDetailRoute('settings', pluginId)); });
    }, [openRecoveryRoute, router]);

    // Board records use the Session's existing Plain/E2EE owner. A locked row
    // therefore recovers through the incumbent Account security screen after
    // establishing this exact Session Home; no Board-local key flow exists.
    const prepareEncryption = React.useCallback(async (): Promise<void> => {
        try {
            const opened = await openAccountSecurityForHome({
                serverId: props.address.serverId,
                router,
                refreshAuth: auth.refreshFromActiveServer,
            });
            if (!opened) presentRecoveryNavigationError();
        } catch {
            presentRecoveryNavigationError();
        }
    }, [auth.refreshFromActiveServer, presentRecoveryNavigationError, props.address.serverId, router]);

    const askAgent = useSessionBoardComposerSuggestion(props.address);

    return (
        <SessionBoardWidgetCandidateSelection
            session={session}
            runtime={pluginRuntime}
            boardFeatureEnabled={boardFeatureEnabled}
            canEdit={binding.status === 'ready' && binding.snapshot.canEdit}
            hostedHtmlRendererAvailable={callerHostedHtmlRuntime !== null}
        >
            {({ candidates: installedWidgetCandidates, resolveSourceAvailability }) => (
                <SessionBoardControllerOwner
                    address={props.address}
                    input={{
                        sessionId: props.address.sessionId,
                        serverId: props.address.serverId,
                        binding,
                        actions,
                        approvalPending: approval.pending,
                        requestApprovalContinuation: approval.request,
                        resolveSourceAvailability,
                        chooseViewRemovalDisposition,
                        promptViewTitle,
                        onManagePlugin: managePluginForItem,
                        onPrepareEncryption: prepareEncryption,
                        // Absent when no mounted composer of this exact Home/Session can
                        // accept it, so the Add row never draws a control that does nothing.
                        ...(askAgent ? { onAskAgent: askAgent } : {}),
                        ...(continuity
                            ? { beforeReplaceNoteDraft: (replace: () => void | Promise<void>) => continuity.draftGuard.run(replace) }
                            : {}),
                        callerHostedHtmlAvailable: callerHostedHtmlRuntime !== null,
                    }}
                    binding={binding}
                    actions={actions}
                    approvalPending={approval.pending}
                    requestApprovalContinuation={approval.request}
                    pluginRuntime={pluginRuntime}
                    callerHostedHtmlRuntime={callerHostedHtmlRuntime}
                    installedWidgetCandidates={installedWidgetCandidates}
                    acquireContent={acquireContent}
                    onViewFocusTargetChange={onViewFocusTargetChange}
                    onViewActionsFocusTargetChange={onViewActionsFocusTargetChange}
                    viewActionsFocusTargetRef={viewActionsFocusTargetRef}
                    {...(props.resolvePrimaryHost ? { resolvePrimaryHost: props.resolvePrimaryHost } : {})}
                >
                    {props.children}
                </SessionBoardControllerOwner>
            )}
        </SessionBoardWidgetCandidateSelection>
    );
}

/** Focused owner seam used by mounted tests without reconstructing runtime boundaries. */
export function SessionBoardControllerOwner(props: React.PropsWithChildren<Readonly<{
    address: SessionAddress;
    input: Omit<SessionBoardControllerInput, 'installedWidgetsAvailable'>;
    binding: SessionBoardBinding & Readonly<{ refresh?: () => void }>;
    actions: SessionBoardActionsPort;
    approvalPending?: boolean;
    requestApprovalContinuation?: ReturnType<typeof useSessionBoardMutationApproval>['request'];
    pluginRuntime: SessionPluginRuntimeState;
    callerHostedHtmlRuntime: CallerHostedHtmlRuntime | null;
    installedWidgetCandidates?: readonly WidgetCandidate[];
    acquireContent?: () => () => void;
    resolvePrimaryHost?: SessionBoardPlacementPrimaryMountResolver;
    onViewFocusTargetChange?: (viewId: string, target: FocusReturnTarget) => void;
    onViewActionsFocusTargetChange?: (target: FocusReturnTarget) => void;
    viewActionsFocusTargetRef?: FocusReturnRef;
}>>): React.ReactElement {
    const installedWidgetCandidates = props.installedWidgetCandidates ?? NO_INSTALLED_WIDGET_CANDIDATES;
    const controllerInput = React.useMemo<SessionBoardControllerInput>(() => ({
        ...props.input,
        // This exact list is the availability fact. Deriving the menu intent
        // here prevents direct/test hosts from diverging from picker contents.
        installedWidgetsAvailable: installedWidgetCandidates.length > 0,
    }), [installedWidgetCandidates, props.input]);
    const controller = useSessionBoardController(controllerInput);
    const shellResolvePrimaryHost: SessionBoardPlacementPrimaryMountResolver = props.resolvePrimaryHost
        ?? NO_PRIMARY_MOUNT;
    // Every generic Board host draws exactly this set: the selected view's placements
    // plus the unplaced recovery items. Keyed by content so an equivalent projection
    // does not hand every consumer a new resolver.
    const selectedViewItemKey = [
        ...(controller.activeView?.placements ?? []).map((placement) => placement.itemId),
        ...controller.recoveredItemIds,
    ].join('\u001f');
    const selectedViewItemIds = React.useMemo(
        () => new Set(selectedViewItemKey.length > 0 ? selectedViewItemKey.split('\u001f') : []),
        [selectedViewItemKey],
    );
    // Fixed shell host slots carry only the Surface's existing virtualization facts.
    // They do not store a primary or let a placement elect itself. An unmeasured or
    // retained surface is not an executable candidate until its body is available.
    const [bodyEligibility, setBodyEligibility] = React.useState<Partial<Record<SessionBoardMountHost, Readonly<{
        viewId: string;
        itemIds: ReadonlySet<string>;
    }>>>>({});
    const onBodyEligibilityChange = React.useCallback<SessionBoardBodyEligibilityReporter>((host, viewId, itemIds) => {
        const facts = { viewId, itemIds };
        setBodyEligibility((current) => ({ ...current, [host]: facts }));
        return () => setBodyEligibility((current) => {
            if (current[host] !== facts) return current;
            const next = { ...current };
            delete next[host];
            return next;
        });
    }, []);
    // Transcript replies that draw an executable item while the transcript list demands them,
    // in the order they arrived on screen. One owner for the whole Session shell, not one per row.
    const [inlineTranscriptDemand, setInlineTranscriptDemand] = React.useState(NO_INLINE_TRANSCRIPT_DEMAND);
    const [inlineTranscriptPreferred, setInlineTranscriptPreferred] = React.useState(NO_INLINE_TRANSCRIPT_PREFERENCE);
    const reportInlineTranscriptDemand = React.useCallback((itemId: string, occurrence: string) => {
        setInlineTranscriptDemand((current) => {
            const occurrences = current.get(itemId) ?? [];
            if (occurrences.includes(occurrence)) return current;
            return new Map(current).set(itemId, [...occurrences, occurrence]);
        });
        return () => setInlineTranscriptDemand((current) => {
            const occurrences = current.get(itemId);
            if (!occurrences?.includes(occurrence)) return current;
            const next = new Map(current);
            const remaining = occurrences.filter((candidate) => candidate !== occurrence);
            if (remaining.length > 0) next.set(itemId, remaining);
            else next.delete(itemId);
            return next;
        });
    }, []);
    // A request lives while a reply that draws the item is on screen; it never waits for a later one.
    React.useEffect(() => {
        setInlineTranscriptPreferred((current) => {
            const kept = [...current].filter((itemId) => inlineTranscriptDemand.has(itemId));
            return kept.length === current.size ? current : new Set(kept);
        });
    }, [inlineTranscriptDemand]);
    const showInlineTranscriptItem = React.useCallback<MountedSessionBoardController['showInlineTranscriptItem']>((itemId, occurrence) => {
        const occurrences = inlineTranscriptDemand.get(itemId);
        if (!occurrences) return 'unavailable';
        const target = occurrence !== undefined && occurrences.includes(occurrence) ? occurrence : occurrences[0];
        if (inlineTranscriptPreferred.has(itemId) && occurrences[0] === target) return 'unchanged';
        setInlineTranscriptPreferred((current) => new Set(current).add(itemId));
        setInlineTranscriptDemand((current) => new Map(current).set(itemId, [target!, ...occurrences.filter((candidate) => candidate !== target)]));
        return 'applied';
    }, [inlineTranscriptDemand, inlineTranscriptPreferred]);
    const releaseInlineTranscriptItem = React.useCallback((itemId: string) => {
        setInlineTranscriptPreferred((current) => {
            if (!current.has(itemId)) return current;
            const next = new Set(current);
            next.delete(itemId);
            return next;
        });
    }, []);
    const resolveInlineTranscriptOccurrence = React.useCallback(
        (itemId: string) => inlineTranscriptDemand.get(itemId)?.[0] ?? null,
        [inlineTranscriptDemand],
    );
    const resolvePrimaryHost = React.useCallback<SessionBoardPlacementPrimaryMountResolver>(
        (itemId, destination, boardView) => shellResolvePrimaryHost(
            itemId,
            destination,
            {
                drawnBySelectedBoardView: boardView?.drawnBySelectedBoardView ?? selectedViewItemIds.has(itemId),
                bodyEligibleHosts: (Object.keys(bodyEligibility) as SessionBoardMountHost[]).filter((host) => (
                    bodyEligibility[host]?.viewId === controller.activeViewId
                    && bodyEligibility[host]?.itemIds.has(itemId)
                )),
                inlineTranscriptDemanded: inlineTranscriptDemand.has(itemId),
                inlineTranscriptPreferred: inlineTranscriptPreferred.has(itemId),
            },
        ),
        [bodyEligibility, controller.activeViewId, inlineTranscriptDemand, inlineTranscriptPreferred, selectedViewItemIds, shellResolvePrimaryHost],
    );
    const value = React.useMemo<MountedSessionBoardController>(() => ({
        address: props.address,
        controller,
        binding: props.binding,
        actions: props.actions,
        approvalPending: props.approvalPending === true,
        ...(props.requestApprovalContinuation
            ? { requestApprovalContinuation: props.requestApprovalContinuation }
            : {}),
        pluginRuntime: props.pluginRuntime,
        callerHostedHtmlRuntime: props.callerHostedHtmlRuntime,
        installedWidgetCandidates,
        ...(props.acquireContent ? { acquireContent: props.acquireContent } : {}),
        resolvePrimaryHost,
        onBodyEligibilityChange,
        reportInlineTranscriptDemand,
        resolveInlineTranscriptOccurrence,
        showInlineTranscriptItem,
        releaseInlineTranscriptItem,
        onViewFocusTargetChange: props.onViewFocusTargetChange ?? (() => {}),
        onViewActionsFocusTargetChange: props.onViewActionsFocusTargetChange ?? (() => {}),
        viewActionsFocusTargetRef: props.viewActionsFocusTargetRef,
    }), [props.acquireContent, props.actions, props.address, props.approvalPending, props.binding, props.callerHostedHtmlRuntime, installedWidgetCandidates, props.onViewActionsFocusTargetChange, props.onViewFocusTargetChange, props.pluginRuntime, props.requestApprovalContinuation, props.viewActionsFocusTargetRef, controller, resolvePrimaryHost, onBodyEligibilityChange, reportInlineTranscriptDemand, resolveInlineTranscriptOccurrence, showInlineTranscriptItem, releaseInlineTranscriptItem]);
    return (
        <SessionBoardControllerContext.Provider value={value}>
            {props.children}
        </SessionBoardControllerContext.Provider>
    );
}

/** Exact-address consumer; a pane can never borrow another retained Session's controller. */
export function useMountedSessionBoardController(address: SessionAddress | null): MountedSessionBoardController | null {
    const mounted = React.useContext(SessionBoardControllerContext);
    if (!mounted || !address) return null;
    return sessionAddressKey(mounted.address) === sessionAddressKey(address) ? mounted : null;
}
