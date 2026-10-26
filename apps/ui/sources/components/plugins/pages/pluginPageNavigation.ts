import * as React from 'react';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import {
    normalizePluginUiSubPathV1,
    type PluginUiInstanceKeyV1,
    type PluginUiLaunchInputV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
    PluginSurfaceOpenRequest,
} from '@/components/plugins/surfaces/openPluginSurface';
import {
    createPluginSurfaceDestinationOpenSurfaceHandler,
    type PluginSurfaceDestinationContainerHandler,
    type PluginSurfaceDestinationOpenResolution,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    buildPluginSurfaceDestinationId,
    normalizePluginSurfaceDestinationSlug,
} from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import {
    isSamePluginSurfaceLaunchAuthority,
    resolveSelectedPluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { createPluginSurfaceLaunchInputStore } from '@/components/plugins/surfaces/pluginSurfaceLaunchInputStore';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    usePluginPages,
    selectPluginPagePlacements,
    type PluginPage,
} from './pluginPages';
import { appendPluginPageRouteSubPath, pluginPageTargetKey, type PluginPageTarget } from './pluginPageRoute';

/**
 * Host-provided navigation into a plugin page (EU-5b), and the launch input
 * that rides with it.
 *
 * The plugin calls `hostApi.openSurface(destination, input, { subPath })`; the host
 * resolves the qualified page, generates the route and pushes it onto the real
 * router. Because the location is a route and not private component state, the
 * user's back/forward walks the page's own navigation, a deep link renders the
 * same location, and returning to the page restores it — which is exactly why
 * bb's `navPanel` puts `subPath` in the URL rather than in a panel-local store.
 *
 * The launch input does NOT ride in the route: it is bounded at 8 KiB and a URL
 * is the wrong carrier for it, while the ROUTE must stay a clean, shareable,
 * host-owned path. It rides here instead — as a single pending open, handed to
 * the destination the navigation is going to and retired the moment it lands.
 */

/**
 * One open in flight: the argument of a navigation that has been started and
 * not yet delivered.
 *
 * It carries its own authority and destination because a launch input is only
 * meaningful for the exact surface it was addressed to. `input: undefined` is a
 * real, deliverable fact — an open WITHOUT an argument, which §3.7 requires to
 * REPLACE (not preserve) whatever a previous open staged.
 */
export type PluginPageLaunchOpen = Readonly<{
    target?: PluginPageTarget;
    authority: PluginSurfaceLaunchAuthority;
    /** Qualified `plugin:<pluginId>:<localId>` destination id. */
    pageId: string;
    /** Canonical plugin-local location; `''` at the page root. */
    subPath: string;
    input: PluginUiLaunchInputV1 | undefined;
    /** Ephemeral mount discriminator; never a route or persistence key. */
    instanceKey?: PluginUiInstanceKeyV1;
}>;

export type PluginPageLaunchInputQuery = Readonly<{
    target?: PluginPageTarget;
    authority: PluginSurfaceLaunchAuthority;
    pageId: string;
    subPath: string;
}>;

/**
 * The pending-open handoff between an `openSurface` call and the destination it
 * navigated to.
 *
 * It holds AT MOST ONE open, because §3.7 gives the host one selected page at a
 * time: a second open supersedes the first rather than queueing beside it. The
 * slot is emptied as soon as the destination reads it, so the value's lifetime
 * is one navigation — not the process, not the plugin id, and not the app
 * session.
 */
export type PluginPageLaunchInputStore = Readonly<{
    /** Stages only while the open's captured authority remains current. */
    stage: (open: PluginPageLaunchOpen) => boolean;
    /** The pending open for exactly this authority and location, or `null`. */
    peek: (query: PluginPageLaunchInputQuery) => PluginPageLaunchOpen | null;
    /** The open reached its destination; the handoff slot must not keep it. */
    settle: (open: PluginPageLaunchOpen) => void;
    /** Retire everything not staged under `authority` — or everything. */
    retire: (authority?: PluginSurfaceLaunchAuthority) => void;
    /** Retire a pending open unless one of these exact page authorities retains it. */
    retireOutside: (authorities: readonly PluginSurfaceLaunchAuthority[]) => void;
    subscribe: (listener: () => void) => () => void;
}>;

export function createPluginPageLaunchInputStore(): PluginPageLaunchInputStore {
    const store = createPluginSurfaceLaunchInputStore<PluginPageLaunchOpen>((open) => (
        // Page id and subpath are separately normalized by the route owner.
        // A delimiter makes their pair one exact handoff location without
        // inventing another route or persistence grammar.
        `${pluginPageTargetKey(open.target ?? { kind: 'app' })}\u0000${open.pageId}\u0000${open.subPath}`
    ));
    return Object.freeze({
        stage: store.stage,
        peek: (query) => store.peek({
            authority: query.authority,
            handoffKey: `${pluginPageTargetKey(query.target ?? { kind: 'app' })}\u0000${query.pageId}\u0000${query.subPath}`,
        }),
        settle: store.settle,
        retire: store.retire,
        retireOutside: store.retireOutside,
        subscribe: store.subscribe,
    });
}

type PluginPageLaunchInputScopeValue = Readonly<{
    target: PluginPageTarget;
    authoritiesByPageId: PluginPageLaunchAuthorities;
    store: PluginPageLaunchInputStore;
}>;

const PluginPageLaunchInputScopeContext = (
    React.createContext<PluginPageLaunchInputScopeValue | null>(null)
);

/**
 * The exact authority for every mounted app page. The key is the canonical
 * qualified page id; its value is sourced from that page's union contribution,
 * never from the app-scope model's coarse machine/generation roll-up.
 */
export type PluginPageLaunchAuthorities = ReadonlyMap<string, PluginSurfaceLaunchAuthority>;

/**
 * Derive launch authorities from the one canonical page catalog.
 *
 * A page without the union's exact selected materialization stamp is not a
 * launch destination. This deliberately does not fall back to the app shell's
 * ambient machine, because that could bind a bounded input to a replica the
 * user did not select.
 */
export function resolvePluginPageLaunchAuthorities(input: Readonly<{
    pages: readonly PluginPage[];
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>): PluginPageLaunchAuthorities {
    const authorities = new Map<string, PluginSurfaceLaunchAuthority>();
    // Retirement is synchronous. Do not expose an authority during the narrow
    // interval before React remounts the successor Account's tree.
    if (input.accountLifetime && !input.accountLifetime.isCurrent()) {
        return authorities;
    }
    for (const page of input.pages) {
        const authority = resolveSelectedPluginSurfaceLaunchAuthority({
            placement: page.placement,
            accountLifetime: input.accountLifetime,
        });
        if (authority) authorities.set(page.id, authority);
    }
    return authorities;
}

/**
 * The lifecycle owner of every in-flight and delivered page launch input.
 *
 * It is mounted by the app-shell plugin projection owner, so the state lives
 * exactly as long as the authority that produced it: when the server/account,
 * the contributing machine or the projection generation changes, the value is
 * retired instead of being handed to a surface it was never addressed to, and
 * when the scope unmounts nothing survives it. A module-global map keyed by page
 * id survived all of those — which is the defect this replaces.
 *
 * Written with `createElement` rather than JSX so the whole navigation owner
 * (route building, destination resolution, staging and delivery) stays in one
 * `.ts` module instead of splitting across a second file.
 */
export function PluginPageLaunchInputScope(props: Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    target: PluginPageTarget;
    pages?: readonly PluginPage[];
    children: React.ReactNode;
}>): React.ReactElement {
    const [store] = React.useState(createPluginPageLaunchInputStore);
    // This is the incumbent Account lifecycle, not a page-owned generation.
    // Capturing it here makes staging, delivery and retirement all consume the
    // same authority the destination mount will receive.
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [, refreshAfterAccountRetirement] = React.useReducer((revision: number) => revision + 1, 0);
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = usePluginLocalizedTextResolver({
            projection: props.pluginUiProjection,
            locale: pluginLocale,
    });
    const ownPlacements = React.useMemo(() => props.pages ? [] : selectPluginPagePlacements(props.pluginUiProjection,
        { container: 'appPage', targetKind: props.target.kind }), [props.pages, props.pluginUiProjection, props.target.kind]);
    const ownPages = usePluginPages({ target: props.target,
        placements: ownPlacements,
        localize: localizePluginText,
    });
    const pages = props.pages ?? ownPages;
    const targetKey = pluginPageTargetKey(props.target);
    React.useEffect(() => () => store.retire(), [store, targetKey]);
    const authoritiesByPageId = React.useMemo(
        () => resolvePluginPageLaunchAuthorities({ pages, accountLifetime }),
        [accountLifetime, pages],
    );

    React.useEffect(() => {
        // A selected page origin is a full producer identity. Keep a pending
        // handoff only if that exact page authority remains selected; a union
        // machine/generation cannot retain an input for another plugin's page.
        store.retireOutside([...authoritiesByPageId.values()]);
    }, [authoritiesByPageId, store]);
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            // `onRetire` runs synchronously from the incumbent reset owner.
            // Clear the bounded handoff before the successor Account mounts,
            // then refresh the context so already-delivered input also loses
            // its stale authority on the next render. Capture can retire the
            // Account while a sibling renders; publish the React update only
            // after that render, without delaying the authority withdrawal.
            store.retire();
            queueMicrotask(refreshAfterAccountRetirement);
        });
        return () => retirement?.dispose();
    }, [accountLifetime, refreshAfterAccountRetirement, store]);
    React.useEffect(() => () => { store.retire(); }, [store]);

    const value = React.useMemo(
        () => Object.freeze({ authoritiesByPageId, store, target: props.target }),
        [authoritiesByPageId, store, props.target],
    );
    return React.createElement(
        PluginPageLaunchInputScopeContext.Provider,
        { value },
        props.children,
    );
}

/**
 * Stage the argument of one open for its destination.
 *
 * Outside a scope there is no authority to bind the value to, so staging is
 * refused rather than falling back to an unbound lifetime — the failure mode
 * this owner exists to prevent.
 */
export function usePluginPageLaunchInputStaging(): (open: Readonly<{
    target?: PluginPageTarget;
    pageId: string;
    subPath: string;
    input: PluginUiLaunchInputV1 | undefined;
    instanceKey?: PluginUiInstanceKeyV1;
}>) => boolean {
    const scope = React.useContext(PluginPageLaunchInputScopeContext);
    return React.useCallback((open) => {
        if (!scope) return false;
        if (open.target && pluginPageTargetKey(open.target) !== pluginPageTargetKey(scope.target)) return false;
        const authority = scope.authoritiesByPageId.get(open.pageId);
        if (!authority) return false;
        return scope.store.stage({ authority, ...open, target: scope.target });
    }, [scope]);
}

/**
 * The minimal catalog fact needed to activate an already-resolved app page.
 *
 * The compact catalog remains a discovery projection: it does not own page
 * lifetime, route currentness, or launch input. This adapter accepts only its
 * host-issued identity and route, then crosses the incumbent page route/launch
 * owner exactly as an input-less `openSurface` would.
 */
export type PluginPageCatalogActivation = Readonly<{
    id: string;
    routePath: string;
}>;

export type CreatePluginPageCatalogActivationHandlerInput = Readonly<{
    pathname: string;
    navigate: (routePath: string) => void;
    stageLaunchInput: (open: Readonly<{
        pageId: string;
        subPath: string;
        input: PluginUiLaunchInputV1 | undefined;
    }>) => boolean;
}>;

/**
 * Adapts a compact catalog activation to the page launch owner.
 *
 * Staging intentionally precedes route-currentness suppression. A page that is
 * already mounted at its root must observe a user navigation as an explicit
 * input-less open, replacing any earlier ephemeral payload without adding a
 * second history entry.
 */
export function createPluginPageCatalogActivationHandler(
    input: CreatePluginPageCatalogActivationHandlerInput,
): (destination: PluginPageCatalogActivation) => void {
    return (destination) => {
        fireAndForget(Promise.resolve(runGuardedNavigation(() => {
            // Staging can update an already-mounted editor, so it belongs
            // after the dirty decision, not merely before guarded routing.
            input.stageLaunchInput({ pageId: destination.id, subPath: '', input: undefined });
            if (destination.routePath === input.pathname) return;
            input.navigate(destination.routePath);
        })), { tag: 'plugin-page-catalog-navigation' });
    };
}

/**
 * The single React adapter for compact app-page activation.
 *
 * It reuses the canonical launch-input staging scope and the real route owner;
 * callers cannot create a parallel route or ephemeral-input path.
 */
export function usePluginPageCatalogActivationHandler(): (
    destination: PluginPageCatalogActivation,
) => void {
    const router = useRouter();
    const pathname = usePathname();
    const stageLaunchInput = usePluginPageLaunchInputStaging();
    return React.useMemo(() => createPluginPageCatalogActivationHandler({
        pathname,
        stageLaunchInput,
        navigate: (routePath) => {
            router.push(routePath as Parameters<typeof router.push>[0]);
        },
    }), [pathname, router, stageLaunchInput]);
}

/**
 * The mounted page's launch input.
 *
 * The destination TAKES the pending open — it does not read a shared slot that
 * keeps holding it — and then holds the value itself for as long as it is the
 * same page, at the same plugin-local location, under the same authority. That
 * is what makes the three §3.7 rules hold at once: reopening with new input
 * replaces it, an open without input clears it, and a later navigation to the
 * same location cannot inherit an argument from an earlier one.
 */
export function usePluginPageLaunch(location: Readonly<{
    pluginId: string;
    localId: string;
    subPath: string | null;
}>): PluginPageLaunchOpen | null {
    const scope = React.useContext(PluginPageLaunchInputScopeContext);
    const { localId, pluginId, subPath } = location;
    // Built from the ROUTE, through the canonical qualified-id builder, so the
    // open is also retired when the route resolves to no page at all (an
    // uninstalled, hidden or unknown destination) instead of being left pending.
    const pageId = buildPluginSurfaceDestinationId(
        pluginId.trim(),
        normalizePluginSurfaceDestinationSlug(localId),
    );
    const authority = scope?.authoritiesByPageId.get(pageId) ?? null;

    const subscribe = React.useCallback((onStoreChange: () => void) => (
        scope ? scope.store.subscribe(onStoreChange) : () => {}
    ), [scope]);
    const getSnapshot = React.useCallback(() => (
        scope && authority && subPath !== null
            ? scope.store.peek({ authority, pageId, subPath, target: scope.target })
            : null
    ), [authority, pageId, scope, subPath]);
    const staged = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const [delivered, setDelivered] = React.useState<PluginPageLaunchOpen | null>(null);
    const retained = (
        delivered !== null
        && scope !== null
        && authority !== null
        && subPath !== null
        && delivered.pageId === pageId
        && delivered.subPath === subPath
        && pluginPageTargetKey(delivered.target ?? { kind: 'app' }) === pluginPageTargetKey(scope.target)
        && isSamePluginSurfaceLaunchAuthority(delivered.authority, authority)
    ) ? delivered : null;
    if (staged !== null && staged !== retained) {
        setDelivered(staged);
    } else if (delivered !== null && retained === null) {
        // The authority or the location moved on; the argument does not follow.
        setDelivered(null);
    }

    React.useEffect(() => {
        if (staged !== null) scope?.store.settle(staged);
    }, [scope, staged]);

    return staged ?? retained;
}

/**
 * Backwards-compatible narrow view of the page launch handoff. New mount
 * adapters consume {@link usePluginPageLaunch} so the optional instance key
 * travels with the same ephemeral currentness proof as launch input.
 */
export function usePluginPageLaunchInput(location: Readonly<{
    pluginId: string;
    localId: string;
    subPath: string | null;
}>): PluginUiLaunchInputV1 | undefined {
    return usePluginPageLaunch(location)?.input;
}

export type CreatePluginPageDestinationHandlerInput = Readonly<{
    pages: readonly PluginPage[];
    navigate: (routePath: string) => void;
    stageLaunchInput: (open: Readonly<{
        target?: PluginPageTarget;
        pageId: string;
        subPath: string;
        input: PluginUiLaunchInputV1 | undefined;
        instanceKey?: PluginUiInstanceKeyV1;
    }>) => boolean;
}>;

/**
 * Compatibility constructor for tests and non-React adapters. Unlike the
 * retired local-page lookup, it accepts the complete mounted app projection and
 * delegates its exact binding decision to the shared destination resolver.
 */
export type CreatePluginPageOpenSurfaceHandlerInput = CreatePluginPageDestinationHandlerInput & Readonly<{
    target?: PluginPageTarget;
    placements: readonly PluginUiSurfacePlacementProjection[];
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    policyContext?: PluginUiPolicyEvaluationContext;
}>;

function openResolvedPluginPage(input: Readonly<{
    page: PluginPage;
    request: PluginSurfaceOpenRequest;
}> & Pick<CreatePluginPageDestinationHandlerInput, 'navigate' | 'stageLaunchInput'>): PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome> {
    const { page, request } = input;
    if (request.instanceKey !== undefined) {
        return {
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_instance_key_unsupported',
        };
    }
    // Availability is the catalog's decision, not a second one made here.
    if (page.disabledReason) {
        return { ok: false, code: 'unavailable', reason: page.disabledReason };
    }
    // Concrete mounted requests should already have crossed the Protocol
    // request schema, but this host boundary still refuses an invalid direct
    // invocation rather than coercing it to the page root.
    const subPath = request.subPath === undefined
        ? ''
        : normalizePluginUiSubPathV1(request.subPath);
    if (subPath === null) {
        return {
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_invalid',
        };
    }
    let outcome: PluginSurfaceOpenOutcome = {
        ok: false, code: 'unavailable', reason: 'plugin_page_navigation_cancelled',
    };
    const admission = runGuardedNavigation(() => {
        const staged = input.stageLaunchInput({
            target: page.target,
            pageId: page.id,
            subPath,
            input: request.input,
            ...(request.instanceKey === undefined ? {} : { instanceKey: request.instanceKey }),
        });
        // A route with no launch value has the same selection contract as catalog
        // navigation. Real payloads remain bound to the exact current producer.
        if (!staged && request.input !== undefined) {
            outcome = { ok: false, code: 'unavailable', reason: 'plugin_surface_open_origin_unavailable' };
            return;
        }
        input.navigate(appendPluginPageRouteSubPath(page.routePath, subPath));
        outcome = { ok: true };
    });
    return admission === true ? outcome : admission.then(() => outcome);
}

export function createPluginPageOpenSurfaceHandler(
    input: CreatePluginPageOpenSurfaceHandlerInput,
): PluginSurfaceOpenHandler {
    return createPluginSurfaceDestinationOpenSurfaceHandler({
        placements: input.placements,
        targetKind: input.target?.kind ?? 'app',
        ...(input.accountLifetime === undefined ? {} : { accountLifetime: input.accountLifetime }),
        ...(input.policyContext === undefined ? {} : { policyContext: input.policyContext }),
        handlers: { appPage: createPluginPageDestinationHandler(input) },
    });
}

/**
 * Page adapter for the common qualified destination resolver.
 *
 * The resolver has already selected one exact `appPage` binding. This adapter
 * only finds that same catalog entry by projection placement identity and asks
 * the incumbent route/launch-input owner to navigate; it never retries a
 * reference lookup or chooses a different page.
 */
export function createPluginPageDestinationHandler(
    input: CreatePluginPageDestinationHandlerInput,
): PluginSurfaceDestinationContainerHandler {
    return (resolution: PluginSurfaceDestinationOpenResolution) => {
        if (resolution.placement.binding.container !== 'appPage') {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_owner_unavailable',
            };
        }
        const page = input.pages.find((candidate) => candidate.placement.id === resolution.placement.id
            && candidate.target.kind === resolution.placement.binding.targetKind
            && candidate.pluginId === resolution.placement.binding.destination.pluginId
            && candidate.localId === resolution.placement.binding.destination.localId) ?? null;
        if (!page) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_unknown',
            };
        }
        return openResolvedPluginPage({ ...input, page, request: resolution.request });
    };
}

/** The route owner exposed as a container adapter for the shared resolver. */
export function usePluginPageDestinationHandler(input: Readonly<{
    pages: readonly PluginPage[];
}>): PluginSurfaceDestinationContainerHandler {
    const router = useRouter();
    const pathname = usePathname();
    const stageLaunchInput = usePluginPageLaunchInputStaging();
    const { pages } = input;
    return React.useMemo(() => createPluginPageDestinationHandler({
        pages,
        stageLaunchInput,
        navigate: (routePath) => {
            if (routePath === pathname) return;
            router.push(routePath as Parameters<typeof router.push>[0]);
        },
    }), [pages, pathname, router, stageLaunchInput]);
}
