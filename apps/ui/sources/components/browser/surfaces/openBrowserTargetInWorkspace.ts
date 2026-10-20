import type {
    BrowserPlatformV1,
    BrowserProfileV1,
    BrowserViewTargetV1,
    FeatureDecision,
    LocalServiceLaunchTargetV1,
    ActionExecuteResult,
    ActionExecutorContext,
    ActionId,
} from '@happier-dev/protocol';
import { BrowserWorkspaceOpenResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BrowserRuntimeWorkspaceOpeningAdapter } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { claimBrowserRuntimeWorkspaceOpenCommand } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import {
    openBrowserExternalTabSelection,
    selectBrowserTargetAdapter,
} from '@/sync/domains/browser/adapters/selection';
import { evaluateBrowserTargetPolicy } from '@/sync/domains/browser/policy/evaluate';
import { resolveLocalBrowserProfile } from '@/sync/domains/browser/profiles/localBrowserProfile';
import {
    createBrowserViewState,
    openBrowserTarget,
    resolveBrowserViewIdForTarget,
} from '@/sync/domains/browser/store';
import type { BrowserViewState } from '@/sync/domains/browser/types';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { selectLocalServicePreviewByBrowserTarget } from '@/sync/domains/local/services/preview/store';
import { openOrCreateLocalServicePreviewViaMachineRpc } from '@/sync/domains/local/services/preview/machineRpc';
import { normalizeLocalServicePreviewSnapshotPayload } from '@/sync/domains/local/services/preview/api';
import { publishLocalServicePreviewSnapshot } from '@/sync/domains/local/services/preview/sharedStore';
import { LocalServicePreviewServiceTargetV1Schema } from '@happier-dev/protocol/local/services/preview/v1';

import {
    createBrowserViewDetailsTab,
    resolveBrowserTargetSurfaceSessionId,
} from './browserSurfaceDetailsTabModel';

/**
 * Where an "open target as a browser view" originates. Desktop scopes own a side-by-side
 * details workspace (a real tab); the mobile full-screen surface is a single host. The scope
 * also selects the surface-session-id namespace so the seeded content record and the tab the
 * host later mounts agree on identity.
 */
export type OpenBrowserTargetScope = 'sessionDetails' | 'workspaceDetails' | 'sessionMobile';

type OpenDetailsTab = (
    tab: DetailsTab,
    options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>,
) => void;

/**
 * Pure inputs shared by the tab builder and the content-record seed so the two cannot diverge.
 * The same shape feeds {@link resolveBrowserViewTargetOpen} (pure) and the side-effecting
 * {@link createOpenBrowserTargetInWorkspace}.
 */
export type ResolveBrowserViewTargetOpenInput = Readonly<{
    scope: OpenBrowserTargetScope;
    platform: BrowserPlatformV1;
    localServicePreviewState?: LocalServicePreviewState | null;
    browserFeatureDecision?: FeatureDecision | null;
    browserProfile?: BrowserProfileV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
}>;

export type CreateOpenBrowserTargetInWorkspaceDeps = ResolveBrowserViewTargetOpenInput & Readonly<{
    scopeId: string;
    accountLifetime: ServerAccountScopeLifetime | null;
    /** Originating workspace cancellation, including an approval wait. */
    readonly signal?: AbortSignal;
    /** Latest owning workspace facts, read only after Action admission. */
    readOpenFacts?: () => ResolveBrowserViewTargetOpenInput;
    isCurrent?: () => boolean;
    actionExecute?: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;
    openDetailsTab: OpenDetailsTab;
    /**
     * Records the opened target as a recent. Supplied by the caller because the recents store lives
     * outside this owner (FP-BRW-LAUNCHER-1 wires it to the launchpad's recent section); fold the
     * target via the canonical `rememberBrowserRecentTarget` reducer in `targets/recents.ts`.
     */
    onRememberRecentTarget?: (target: BrowserViewTargetV1) => void;
}>;

/**
 * The deterministic open INPUTS for a target: the `browser-view` tab (carrying ONLY `target` +
 * identity) plus the resolved current-url seam. This is what the side-effecting opener needs — it
 * does NOT carry a materialized `BrowserViewState` (DV-OPEN-SEAM: the live record is derived ONCE,
 * at the renderer's `createInitialBrowserState`, from the resource's `target` via the same
 * `openBrowserTarget` resolver — never stashed as a mutable blob on the resource).
 */
export type ResolvedBrowserViewTargetOpenTab = Readonly<{
    tab: DetailsTab;
    browserSessionId: string;
    viewId: string;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
}>;

export type ResolvedBrowserViewTargetOpen = ResolvedBrowserViewTargetOpenTab & Readonly<{
    /**
     * The live browser content/view record the SAME resolver derives from the deterministic inputs.
     * Returned here only as the byte-for-byte proof that the renderer can materialize the record on
     * mount (the mount-and-render closure). The opener never persists it; a denied external-URL
     * policy yields a state WITHOUT a `viewsById[viewId]` entry (fail-closed: a tab, but no
     * navigation).
     */
    seededState: BrowserViewState;
}>;

export type BrowserViewTargetReplacementInput = Readonly<{
    target: BrowserViewTargetV1;
    browserSessionId: string;
    viewId: string;
}>;

/**
 * Matches the launchpad `onOpenTarget` seam so renderers pass it straight through. The optional
 * per-open `options` are presentation hints. The admitted opener re-resolves current owning
 * workspace policy and URL facts so UI and Agent callers cannot override navigation authority.
 */
export type OpenBrowserViewTarget = (
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
) => void | Promise<ActionExecuteResult>;

export type BrowserWorkspaceTargetOpener = ((
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
) => Promise<ActionExecuteResult>) & Readonly<{
    runtimeAdapter: BrowserRuntimeWorkspaceOpeningAdapter;
}>;

/**
 * Canonical resource builder for an in-place browser-view retarget. Unlike a new open, a retarget
 * must preserve the mounted browser session/view identity so the workspace replaces the current
 * durable tab instead of creating a second view. Keeping this beside the new-tab opener makes this
 * module the only production owner allowed to construct `browser-view` tab resources.
 */
export function resolveBrowserViewTargetReplacementTab(
    input: BrowserViewTargetReplacementInput,
): DetailsTab {
    return createBrowserViewDetailsTab(input);
}

const SCOPE_SESSION_ID_PART: Readonly<Record<OpenBrowserTargetScope, string>> = {
    sessionDetails: 'details',
    workspaceDetails: 'details',
    sessionMobile: 'mobile',
};

/**
 * The pure open-options resolver shared by the details renderer's mount-seed and this opener's
 * tab pre-seed. External-URL targets are routed through `evaluateBrowserTargetPolicy`; a denied
 * decision flows into the store as a non-navigating record (the adapter is unavailable), never a
 * blind navigation. Local-service previews resolve their access URL/expiry from the live preview
 * state. (Extracted out of `browserDetailsSurfaceRenderer.tsx` so seed parity is structural.)
 */
export function resolveBrowserTargetOpenOptions(params: Readonly<{
    browserSessionId: string;
    viewId?: string;
    target: BrowserViewTargetV1;
    localServicePreviewState?: LocalServicePreviewState | null;
    browserFeatureDecision?: FeatureDecision | null;
    browserProfile?: BrowserProfileV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    platform: BrowserPlatformV1;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
}>): Parameters<typeof openBrowserTarget>[2] {
    if (params.target.kind === 'externalUrl' || params.target.kind === 'streamedBrowser') {
        const targetPolicyDecision = evaluateBrowserTargetPolicy({
            target: params.target,
            // The in-app browser engines carry no daemon-issued profile; fall back to the host-local
            // default so an opened external URL is evaluated against a usable profile instead of
            // failing closed with `profile_missing` (which would strand the tab on the launchpad).
            profile: resolveLocalBrowserProfile(params.browserProfile),
            browserFeatureDecision: params.browserFeatureDecision,
            allowExternalUrlBrowsing: params.allowExternalUrlBrowsing ?? true,
        });
        return {
            browserSessionId: params.browserSessionId,
            ...(params.viewId ? { viewId: params.viewId } : {}),
            platform: params.platform,
            targetPolicyDecision,
            desktopWebViewAvailability: params.desktopWebViewAvailability,
            ...(params.currentUrl ? { currentUrl: params.currentUrl } : {}),
            ...(params.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: params.currentUrlExpiresAt } : {}),
        };
    }

    if (params.target.kind !== 'localServicePreview' || !params.localServicePreviewState) {
        return {
            browserSessionId: params.browserSessionId,
            ...(params.viewId ? { viewId: params.viewId } : {}),
            platform: params.platform,
            ...(params.currentUrl ? { currentUrl: params.currentUrl } : {}),
            ...(params.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: params.currentUrlExpiresAt } : {}),
        };
    }

    const preview = selectLocalServicePreviewByBrowserTarget(params.localServicePreviewState, params.target);
    const currentUrl = params.currentUrl ?? preview?.accessUrl;
    const previewExpiresAt = typeof preview?.expiresAt === 'number' ? preview.expiresAt : undefined;
    const currentUrlExpiresAt = params.currentUrlExpiresAt ?? previewExpiresAt;
    return {
        browserSessionId: params.browserSessionId,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        platform: params.platform,
        ...(currentUrl ? { currentUrl } : {}),
        ...(currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt } : {}),
    };
}

function readResolvedCurrentUrl(target: BrowserViewTargetV1, options: Parameters<typeof openBrowserTarget>[2]): {
    currentUrl?: string;
    currentUrlExpiresAt?: number;
} {
    const resolved: { currentUrl?: string; currentUrlExpiresAt?: number } = {};
    if (options.currentUrl) {
        resolved.currentUrl = options.currentUrl;
    } else if (target.kind === 'externalUrl') {
        resolved.currentUrl = target.url;
    }
    if (options.currentUrlExpiresAt !== undefined) {
        resolved.currentUrlExpiresAt = options.currentUrlExpiresAt;
    }
    return resolved;
}

/**
 * Pure resolution of an "open target" into BOTH a details-workspace tab and a live content
 * record under one identity. No side effects — the side-effecting opener composes this with
 * `openDetailsTab` + recent tracking.
 *
 * When the caller already resolved the open (the launchpad row resolves its own policy/url with
 * the profile in hand and passes them via `options`), the opener honors that resolution instead
 * of re-evaluating: `options.targetPolicyDecision` short-circuits policy, and the resolved
 * url/expiry/availability/platform are preferred. Otherwise it falls back to the shared
 * `deps`-based resolver so a context-less caller (e.g. the Services binding) still resolves
 * policy/preview-url correctly.
 */
function resolveOpenOptions(
    input: ResolveBrowserViewTargetOpenInput,
    target: BrowserViewTargetV1,
    options: BrowserLaunchpadOpenTargetOptions | undefined,
    browserSessionId: string,
): Parameters<typeof openBrowserTarget>[2] {
    const platform = options?.platform ?? input.platform;
    const desktopWebViewAvailability = options?.desktopWebViewAvailability ?? input.desktopWebViewAvailability;
    return options?.targetPolicyDecision !== undefined
        ? {
            browserSessionId,
            platform,
            targetPolicyDecision: options.targetPolicyDecision,
            desktopWebViewAvailability,
            ...(options.currentUrl ? { currentUrl: options.currentUrl } : {}),
            ...(options.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: options.currentUrlExpiresAt } : {}),
        }
        : resolveBrowserTargetOpenOptions({
            browserSessionId,
            target,
            localServicePreviewState: input.localServicePreviewState,
            browserFeatureDecision: input.browserFeatureDecision,
            browserProfile: input.browserProfile,
            desktopWebViewAvailability,
            allowExternalUrlBrowsing: input.allowExternalUrlBrowsing,
            platform,
            ...(options?.currentUrl ? { currentUrl: options.currentUrl } : {}),
            ...(options?.currentUrlExpiresAt !== undefined ? { currentUrlExpiresAt: options.currentUrlExpiresAt } : {}),
        });
}

/**
 * Resolve the deterministic open INPUTS — the `browser-view` tab (target + identity) and the
 * resolved current-url seam — WITHOUT materializing a `BrowserViewState`. This is what the
 * side-effecting opener uses, so it does NO throwaway seed compute (B-RC2); the live record is
 * derived once at the renderer from the resource's `target` via the SAME `openBrowserTarget`
 * resolver (DV-OPEN-SEAM).
 */
export function resolveBrowserViewTargetOpenTab(
    input: ResolveBrowserViewTargetOpenInput,
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
): ResolvedBrowserViewTargetOpenTab {
    const browserSessionId = resolveBrowserTargetSurfaceSessionId(SCOPE_SESSION_ID_PART[input.scope], target);
    const viewId = resolveBrowserViewIdForTarget(target);
    const openOptions = resolveOpenOptions(input, target, options, browserSessionId);
    const resolvedUrl = readResolvedCurrentUrl(target, openOptions);
    // The canonical `browser-view` workspace tab — a CONSUMER of the one details-workspace engine.
    // It carries the same `browserSessionId`/`viewId` the renderer derives the content record under,
    // so the tab the host later mounts and the live record agree on identity. The tab seam is
    // URL-free: the live URL/expiry live on the resolver-derived record, not on the resource.
    const tab = createBrowserViewDetailsTab({ target, browserSessionId, viewId });
    return {
        tab,
        browserSessionId,
        viewId,
        ...resolvedUrl,
    };
}

export function resolveBrowserViewTargetOpen(
    input: ResolveBrowserViewTargetOpenInput,
    target: BrowserViewTargetV1,
    options?: BrowserLaunchpadOpenTargetOptions,
): ResolvedBrowserViewTargetOpen {
    const resolvedTab = resolveBrowserViewTargetOpenTab(input, target, options);
    const openOptions = resolveOpenOptions(input, target, options, resolvedTab.browserSessionId);
    // The byte-for-byte proof of materializability: the SAME resolver the renderer uses, derived
    // from the deterministic inputs. The opener does NOT call this — only the renderer materializes
    // the record on mount (DV-OPEN-SEAM).
    const seededState = openBrowserTarget(createBrowserViewState(), target, openOptions);
    return {
        ...resolvedTab,
        seededState,
    };
}

let workspaceOpenSequence = 0;

/**
 * Canonical admitted workspace opener. The runtime leaf selects the target and opens only the
 * deterministic tab resource; the renderer materializes live Browser state when it mounts.
 */
export function createOpenBrowserTargetInWorkspace(
    deps: CreateOpenBrowserTargetInWorkspaceDeps,
): BrowserWorkspaceTargetOpener {
    const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'runtime_action_disabled',
        error: 'runtime_action_disabled:browser:browser_view_unavailable' });
    const runtimeAdapter: BrowserRuntimeWorkspaceOpeningAdapter = {
        scopeId: deps.scopeId,
        accountLifetime: deps.accountLifetime,
        open: async (request, context) => {
            const current = () => deps.accountLifetime?.isCurrent() === true
                && deps.isCurrent?.() !== false && !context.signal?.aborted;
            if (!current()) return unavailable();
            const facts = deps.readOpenFacts?.() ?? deps;
            const target = request.target;
            const resolved = resolveBrowserViewTargetOpenTab(facts, target);
            // Launchpad policy/URL options are presentation hints, not authority. UI and Agent
            // resolve the same current workspace facts after approval, at this one selector.
            const openOptions = resolveOpenOptions(facts, target, undefined, resolved.browserSessionId);
            const selection = selectBrowserTargetAdapter({
                target,
                platform: openOptions.platform,
                targetPolicyDecision: openOptions.targetPolicyDecision,
                desktopWebViewAvailability: openOptions.desktopWebViewAvailability,
            });
            if (!selection.ok) return { ok: false, errorCode: 'runtime_action_disabled',
                error: 'runtime_action_disabled:browser:browser_adapter_unavailable' };
            if (!current()) return unavailable();
            if (selection.outcome === 'openExternalTab') {
                if (!await openBrowserExternalTabSelection(selection)) return { ok: false,
                    errorCode: 'runtime_action_disabled', error: 'runtime_action_disabled:browser:browser_adapter_unavailable' };
            } else {
                deps.openDetailsTab(resolved.tab, { intent: 'default' });
                deps.onRememberRecentTarget?.(target);
            }
            return BrowserWorkspaceOpenResultV1Schema.parse({ v: 1, commandId: request.commandId,
                status: 'dispatched', adapterKind: selection.adapterKind, events: [],
                outcome: selection.outcome === 'openExternalTab' ? 'externalTab' : 'workspaceTab' });
        },
    };
    const open = async (target: BrowserViewTargetV1): Promise<ActionExecuteResult> => {
        if (!deps.accountLifetime?.isCurrent() || deps.isCurrent?.() === false || deps.signal?.aborted) return unavailable();
        const execute = deps.actionExecute ?? (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
        const commandId = `workspace-open:${Date.now()}:${++workspaceOpenSequence}`;
        // The admitted Action opens through this opener, so Details knows which region opened it.
        const releaseClaim = claimBrowserRuntimeWorkspaceOpenCommand(runtimeAdapter, commandId);
        try {
            return await execute('browser.workspace.open', { scopeId: runtimeAdapter.scopeId, commandId, target },
                { surface: 'ui', authority: 'present_user', serverId: deps.accountLifetime?.scope.serverId,
                    expectedAccountId: deps.accountLifetime?.scope.accountId, signal: deps.signal });
        } finally {
            releaseClaim();
        }
    };
    return Object.assign(open, { runtimeAdapter });
}

/**
 * PR-14 binding helper — the ONE place a Services `LocalServiceLaunchTarget` becomes a
 * `BrowserViewTargetV1`. Preview identity comes from registration. A launch target without
 * a browser target is an intent to register, never a second preview identity.
 */
export function mapLocalServiceLaunchTargetToBrowserTarget(
    target: LocalServiceLaunchTargetV1,
): BrowserViewTargetV1 | null {
    return target.browserTarget ?? null;
}

/**
 * The exact value a mount site passes as FP-LSV-HOST-1's `onOpenServiceInBrowser` prop: maps the
 * Services launch target to a browser target, then admits it through the canonical opener.
 * Returns the action outcome; admission does not claim the preview page has loaded.
 */
export type ServicesOpenInBrowserResult =
    | Readonly<{ status: 'succeeded' }>
    | Readonly<{ status: 'denied'; reasonCode: string }>
    | ActionApprovalRequestCreatedResult;

type ServicesOpenInBrowserDeps = Readonly<{
    onOpenTarget: OpenBrowserViewTarget;
    platform: BrowserPlatformV1;
}> & Readonly<{
    serverId?: string | null;
    sessionId?: string | null;
}>;

export function bindServicesOpenInBrowser(
    deps: ServicesOpenInBrowserDeps,
): (target: LocalServiceLaunchTargetV1) => Promise<ServicesOpenInBrowserResult> {
    const openBrowserViewTarget = deps.onOpenTarget;
    return async (target: LocalServiceLaunchTargetV1): Promise<ServicesOpenInBrowserResult> => {
        if (target.state === 'unavailable' || !target.machineId.trim()) {
            return { status: 'denied', reasonCode: 'browser_target_unavailable' };
        }
        const browserTarget = mapLocalServiceLaunchTargetToBrowserTarget(target);
        const isSourceQualifiedService = target.sourceClass?.kind === 'managed_service' && target.sessionId === undefined
            && (target.declaration !== undefined || target.cwd !== undefined);
        const parsedService = isSourceQualifiedService && target.sourceClass?.kind === 'managed_service'
            ? LocalServicePreviewServiceTargetV1Schema.safeParse({ kind: 'managed_service', machineId: target.machineId,
                managedServiceId: target.sourceClass.managedServiceId, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
                declaration: target.declaration, cwd: target.cwd }) : null;
        if (isSourceQualifiedService && !parsedService?.success) return { status: 'denied', reasonCode: 'browser_target_unavailable' };
        const serviceTarget = parsedService?.success ? parsedService.data : undefined;
        if (serviceTarget || target.actions.includes('register_preview') || browserTarget?.kind === 'localServicePreview') {
            const inventoryEntryId = target.sourceClass?.kind === 'inventory_entry'
                ? target.sourceClass.inventoryEntryId
                : undefined;
            if (target.source === 'inventory_entry' && !inventoryEntryId) {
                return { status: 'denied', reasonCode: 'browser_target_unavailable' };
            }
            // A new inventory registration belongs to the viewing context. An existing
            // preview keeps its own resource scope, including an explicitly sessionless one.
            const sessionId = serviceTarget ? undefined : inventoryEntryId
                ? deps.sessionId ?? target.sessionId
                : browserTarget?.kind === 'localServicePreview' ? browserTarget.sessionId : target.sessionId;
            const targetReference = serviceTarget ? { serviceTarget } : inventoryEntryId
                ? { inventoryEntryId }
                : { launchTargetId: browserTarget?.kind === 'localServicePreview' ? browserTarget.targetId : target.id };
            const result = await openOrCreateLocalServicePreviewViaMachineRpc({
                serverId: deps.serverId,
                request: {
                    machineId: target.machineId,
                    ...(sessionId ? { sessionId } : {}),
                    ...targetReference,
                },
            });
            if (!result.ok) {
                return {
                    status: 'denied',
                    reasonCode: result.reason.startsWith('refused:')
                        ? result.reason.slice('refused:'.length)
                        : 'preview_registration_failed',
                };
            }
            const snapshot = normalizeLocalServicePreviewSnapshotPayload(result.response.snapshot, target.machineId);
            if (!snapshot) return { status: 'denied', reasonCode: 'preview_registration_failed' };
            publishLocalServicePreviewSnapshot({ machineId: target.machineId, serverId: deps.serverId }, snapshot);
            const preview = result.response.preview;
            const registeredTarget: BrowserViewTargetV1 = preview.resource.browserTarget ?? {
                kind: 'localServicePreview',
                targetId: preview.previewId,
                machineId: preview.resource.machineId,
                ...(preview.resource.sessionId ? { sessionId: preview.resource.sessionId } : {}),
                display: preview.resource.display,
            };
            // Admission expires; an admitted viewer remains live with its registration.
            // A no-private-route row opens the existing runs-elsewhere and Share state.
            const opened = await openBrowserViewTarget(registeredTarget, {
                platform: deps.platform,
                ...(preview.accessUrl ? { currentUrl: preview.accessUrl } : {}),
            });
            if (opened && !opened.ok) return { status: 'denied', reasonCode: opened.errorCode ?? 'browser_target_unavailable' };
            const approval = opened && ActionApprovalRequestCreatedResultSchema.safeParse(opened.result);
            if (approval && approval.success) return approval.data;
            return { status: 'succeeded' };
        }
        if (!browserTarget) {
            return { status: 'denied', reasonCode: 'browser_target_unavailable' };
        }
        const opened = await openBrowserViewTarget(browserTarget);
        if (opened && !opened.ok) return { status: 'denied', reasonCode: opened.errorCode ?? 'browser_target_unavailable' };
        const approval = opened && ActionApprovalRequestCreatedResultSchema.safeParse(opened.result);
        if (approval && approval.success) return approval.data;
        return { status: 'succeeded' };
    };
}
