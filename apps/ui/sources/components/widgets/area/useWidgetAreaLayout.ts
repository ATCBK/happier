import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetAreaActionInputV1, type PluginUiWidgetAreaOperationV1, type PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { usePluginHostReadiness } from '@happier-dev/plugin-ui/hostApi';
import { buildWidgetSurfaceArtifactIdV1, getWidgetLayoutItemIdV1, WidgetAreaLayoutV1Schema, WidgetSurfaceReadV1Schema, type WidgetAreaLayoutV1, type WidgetPlacementV1, type WidgetSurfaceReadV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { storage, useArtifact, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { resumeActionExecutionResult } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WidgetEntityMovementPort } from '@/sync/ops/actions/widgetEntityMovement';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';

/**
 * One personal widget area's operations (a plugin page's declared area, a Project aside). The host
 * binds it to the area, its captured Home/Account and the current page context; presentation only
 * names the semantic operation. It is the same port the public plugin-ui `WidgetSurface`, the
 * declarative `widgetArea` node and the hosted bridge reach — no catalog, layout store or input
 * resolver lives behind it here.
 */
export type WidgetAreaPort = Readonly<{
    /** Writes name the still-displayed admission, not a different selection awaiting its read. */
    execute(operation: PluginUiWidgetAreaOperationV1, signal?: AbortSignal,
        target?: Readonly<{ surface: WidgetSurfaceRefV1; context: WidgetSurfaceContext }>): Promise<PluginUiWidgetAreaResultV1>;
    /** Only the host that already binds the layout owner may bind its existing movement owner. */
    movement?: WidgetEntityMovementPort;
}>;

/** A write that was refused or failed: the area keeps its last good layout and says so once. */
type WidgetAreaWriteSettlement =
    | Readonly<{ kind: 'applied' }>
    /** `error` is the host's own sentence when it gave one beyond the code, so a refusal can say why. */
    | Readonly<{ kind: 'refused'; errorCode: string; error?: string }>;
export type WidgetAreaWriteOutcome = WidgetAreaWriteSettlement
    | Readonly<{ kind: 'approvalPending'; artifactId: string; settled: Promise<WidgetAreaWriteSettlement> }>;

type WidgetAreaReadFailure = Readonly<{ reasonCode: string; reason?: string }>;

export type WidgetAreaLayoutState<C> =
    | Readonly<{ status: 'loading' }>
    /** The host refused the area itself (scope retired, context invalid, Project source unavailable). */
    | Readonly<{ status: 'unavailable'; reasonCode: string; /** The host's own words when it gave any beyond the code. */ reason?: string }>
    | Readonly<{
        status: 'ready'; surface: WidgetSurfaceRefV1; items: WidgetAreaLayoutV1['items']; placements: WidgetPlacementV1[]; canEdit: boolean; isShared: boolean;
        admittedViewer: ServerAccountScope | null;
        documentState: 'missing' | 'present';
        dashboard?: WidgetSurfaceReadV1['dashboard'];
        preset?: WidgetSurfaceReadV1['preset'];
        /** This read's exact publication and binding still admit mounted effects. */
        isCurrent: () => boolean;
        /** A new observation is pending under the same authority; mounted reads still require isCurrent. */
        isReadPending: () => boolean;
        /** A settled retryable read failed; the admitted layout remains current. */
        readFailure?: WidgetAreaReadFailure;
        /** The page context this read was admitted with; widgets follow only an admitted context. */
        context: C;
    }>;

export type WidgetAreaLayout<C> = Readonly<{
    state: WidgetAreaLayoutState<C>;
    /** Retry the same bound document and return its observation, even when the layout is retained. */
    reload: () => Promise<WidgetAreaLayoutState<C> | void>;
    /** One semantic write through the port, then a fresh read of the acknowledged layout. */
    write: (operation: PluginUiWidgetAreaOperationV1) => Promise<WidgetAreaWriteOutcome>;
}>;

function failureCode(result: PluginUiWidgetAreaResultV1): string | null {
    return result.ok ? null : (result.errorCode ?? 'widget_area_unavailable');
}

/** A refusal's sentence (e.g. which Machine cannot answer), when the host said more than its code. */
function failureReason(result: PluginUiWidgetAreaResultV1, code: string): string | undefined {
    const reason = result.ok ? '' : result.error.trim();
    return reason.length > 0 && reason !== code ? reason : undefined;
}

/** Keeps unchanged placements (and an unchanged read) referentially stable, so their cards do not re-render. */
function reconcile<C>(previous: WidgetAreaLayoutState<C>, next: WidgetAreaLayoutState<C>): WidgetAreaLayoutState<C> {
    if (previous.status !== 'ready' || next.status !== 'ready') {
        return previous.status === 'unavailable' && next.status === 'unavailable' && previous.reasonCode === next.reasonCode
            && previous.reason === next.reason ? previous : next;
    }
    const byId = new Map(previous.placements.map(placement => [placement.instance.id, placement]));
    const placements = next.placements.map(placement => {
        const kept = byId.get(placement.instance.id);
        return kept && sameStrictJsonValue(kept, placement) ? kept : placement;
    });
    const samePlacements = placements.length === previous.placements.length && placements.every((placement, index) => placement === previous.placements[index]);
    const itemsById = new Map(previous.items.map(item => [getWidgetLayoutItemIdV1(item), item]));
    const items = next.items.map(item => {
        const kept = itemsById.get(getWidgetLayoutItemIdV1(item));
        return kept && sameStrictJsonValue(kept, item) ? kept : item;
    });
    const sameItems = items.length === previous.items.length && items.every((item, index) => item === previous.items[index]);
    if (samePlacements && previous.isCurrent === next.isCurrent && previous.canEdit === next.canEdit && previous.isShared === next.isShared && sameStrictJsonValue(previous.admittedViewer, next.admittedViewer)
        && sameItems && previous.documentState === next.documentState && sameStrictJsonValue(previous.dashboard ?? null, next.dashboard ?? null)
        && sameStrictJsonValue(previous.preset ?? null, next.preset ?? null)
        && sameStrictJsonValue(previous.readFailure ?? null, next.readFailure ?? null)
        && previous.context === next.context && sameStrictJsonValue(previous.surface, next.surface)) return previous;
    return { ...next, items: sameItems ? previous.items : items, placements: samePlacements ? previous.placements : placements };
}

/**
 * The area's acknowledged layout, read through its port. It reads when mounted and again whenever
 * the host's binding changes (a new page context is admitted by that read before any widget follows
 * it), and after each of its own writes. While a read is in flight the last good layout and its
 * admitted context stay on screen; a refused write never discards them.
 */
export function useWidgetAreaLayout<C extends WidgetSurfaceContext>(port: WidgetAreaPort, context: C): WidgetAreaLayout<C> {
    const hostReadiness = usePluginHostReadiness();
    const lifetime = useActiveServerAccountScopeLifetime();
    const interest = React.useMemo(() => ({ controller: new AbortController() }), [port, context, lifetime]);
    React.useEffect(() => {
        if (interest.controller.signal.aborted) interest.controller = new AbortController();
        const controller = interest.controller;
        return () => controller.abort();
    }, [interest]);
    const approval = useActionApprovalContinuation({ scopeKey: JSON.stringify(lifetime?.scope ?? null),
        serverId: lifetime?.scope.serverId ?? '', onExecuted: () => {} });
    const [state, setState] = React.useState<WidgetAreaLayoutState<C>>({ status: 'loading' });
    const displayed = React.useRef(state);
    displayed.current = state;
    const artifactId = state.status === 'ready' ? state.surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(state.surface) : '';
    const artifact = useArtifact(artifactId);
    const generation = React.useRef(0);
    const mounted = React.useRef(true);
    const binding = React.useRef({ port, context });
    if (binding.current.port !== port || binding.current.context !== context) binding.current = { port, context };
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const read = React.useCallback(async (signal?: AbortSignal) => {
        if (binding.current.port !== port || binding.current.context !== context) return;
        const capturedBinding = binding.current;
        const publications = storage.getState().artifacts;
        const admittedViewer = getActiveServerAccountScope();
        const admittedLifetime = captureActiveServerAccountScopeLifetime();
        const current = ++generation.current;
        const hasAuthority = () => mounted.current && (admittedLifetime ? admittedLifetime.isCurrent() : getActiveServerAccountScope() === null);
        const readPendingFor = (surface: WidgetSurfaceRefV1) => {
            const id = surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(surface);
            const publication = publications[id];
            return () => hasAuthority() && (current !== generation.current || binding.current !== capturedBinding
                || storage.getState().artifacts[id] !== publication);
        };
        let next: WidgetAreaLayoutState<C>;
        try {
            const result = await port.execute({ actionId: 'widgets.item.list' }, signal);
            const refused = failureCode(result);
            const parsed = result.ok ? WidgetSurfaceReadV1Schema.safeParse(result.result) : null;
            // The shared DTO also carries Board widths; this host consumes the existing area's native contract.
            const area = parsed?.success ? WidgetAreaLayoutV1Schema.safeParse({ v: 1, surface: parsed.data.surface, items: parsed.data.items }) : null;
            const admittedArtifactId = parsed?.success ? parsed.data.surface.artifactId ?? buildWidgetSurfaceArtifactIdV1(parsed.data.surface) : '';
            const admittedPublication = publications[admittedArtifactId];
            // A pending observation does not retire admitted facts. Actual scope retirement or
            // a new Artifact publication does; late read results are still rejected below.
            const isCurrent = () => hasAuthority()
                && storage.getState().artifacts[admittedArtifactId] === admittedPublication;
            const refusedReason = refused !== null ? failureReason(result, refused) : undefined;
            next = refused === 'plugin_surface_connection_pending' ? { status: 'loading' }
                : refused !== null ? { status: 'unavailable', reasonCode: refused, ...(refusedReason ? { reason: refusedReason } : {}) }
                : parsed?.success && area?.success ? { status: 'ready', surface: area.data.surface, items: area.data.items,
                    placements: parsed.data.instances, canEdit: parsed.data.canEdit,
                    isShared: parsed.data.isShared === true, admittedViewer, context, isCurrent, isReadPending: readPendingFor(area.data.surface), documentState: parsed.data.state ?? 'present',
                    ...(parsed.data.dashboard ? { dashboard: parsed.data.dashboard } : {}), ...(parsed.data.preset ? { preset: parsed.data.preset } : {}) }
                : { status: 'unavailable', reasonCode: 'invalid_widget_area_result' };
        } catch {
            next = { status: 'unavailable', reasonCode: 'widget_area_unavailable' };
        }
        if (!mounted.current || signal?.aborted || current !== generation.current || binding.current !== capturedBinding) return;
        if (admittedLifetime && !admittedLifetime.isCurrent()) next = { status: 'unavailable', reasonCode: 'widget_area_scope_retired' };
        // A retryable read failure says nothing new about the admitted layout. Keep it while
        // its Account and exact Artifact publication are still current; explicit refusal or
        // retired authority still clears it through the normal unavailable state.
        setState(previous => {
            if (previous.status === 'ready' && previous.isCurrent()) {
                if (next.status === 'loading') return previous;
                if (next.status === 'unavailable' && next.reasonCode === 'widget_area_unavailable') {
                    const { status: _status, ...readFailure } = next;
                    return { ...previous, readFailure, isReadPending: readPendingFor(previous.surface) };
                }
            }
            return reconcile(previous, next);
        });
        return next;
    }, [context, port]);

    // The native Host API keeps its identity through Machine readiness changes. Re-observe its
    // area on settlement/re-admission, including a settled outage that does not advance revision.
    React.useEffect(() => {
        const controller = new AbortController();
        void read(controller.signal);
        return () => controller.abort();
    }, [read, hostReadiness.pending, hostReadiness.revision]);

    React.useEffect(() => {
        if (!artifactId) return;
        const controller = new AbortController();
        // Canonical Artifact publication reaches both ends of an Action-driven transfer.
        void read(controller.signal);
        return () => controller.abort();
    }, [artifactId, artifact, read]);

    const reload = React.useCallback(async () => {
        if (!mounted.current || binding.current.port !== port || binding.current.context !== context) return;
        setState(previous => previous.status === 'unavailable' ? { status: 'loading' } : previous);
        return read();
    }, [context, port, read]);

    const write = React.useCallback(async (operation: PluginUiWidgetAreaOperationV1): Promise<WidgetAreaWriteOutcome> => {
        if (!mounted.current || binding.current.port !== port || binding.current.context !== context)
            return { kind: 'refused', errorCode: 'widget_area_unavailable' };
        const admitted = displayed.current;
        // A newer publication suspends mounted reads, but not a person's edit to the displayed
        // area. Its canonical writer re-reads access and the latest revision before CAS/replay.
        // Both facts fail closed on Account retirement; never retarget to a pending selection.
        if (admitted.status !== 'ready' || (!admitted.isCurrent() && !admitted.isReadPending()))
            return { kind: 'refused', errorCode: 'widget_area_unavailable' };
        let outcome: WidgetAreaWriteOutcome;
        try {
            const result = await port.execute(operation, undefined, { surface: admitted.surface, context: admitted.context });
            const refused = failureCode(result);
            const reason = refused !== null ? failureReason(result, refused) : undefined;
            const receipt = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
            if (receipt?.success && lifetime?.isCurrent()) {
                const capturedBinding = binding.current;
                const settled = resumeActionExecutionResult({ result, actionId: operation.actionId,
                    actionInput: buildWidgetAreaActionInputV1(operation, admitted.surface), scope: lifetime.scope,
                    signal: interest.controller.signal, onApprovalPending: approval.requestApproval,
                }).then((terminal): WidgetAreaWriteSettlement => {
                    if (!mounted.current || binding.current !== capturedBinding || !lifetime.isCurrent())
                        return { kind: 'refused', errorCode: 'widget_area_scope_retired' };
                    void read();
                    return terminal.ok ? { kind: 'applied' } : { kind: 'refused', errorCode: terminal.errorCode ?? 'widget_area_unavailable' };
                }).catch((): WidgetAreaWriteSettlement => ({ kind: 'refused', errorCode: 'widget_area_unavailable' }));
                return { kind: 'approvalPending', artifactId: receipt.data.artifactId, settled };
            }
            outcome = refused !== null ? { kind: 'refused', errorCode: refused, ...(reason ? { error: reason } : {}) }
                : receipt?.success ? { kind: 'refused', errorCode: 'widget_area_scope_retired' }
                : { kind: 'applied' };
        } catch {
            outcome = { kind: 'refused', errorCode: 'widget_area_unavailable' };
        }
        // The Action result is the write acknowledgement. A publication (or this explicit refresh)
        // updates the layout independently; a slow follow-up read must not keep the initiating
        // control busy after the write has already committed.
        if (mounted.current) void read();
        return outcome;
    }, [approval.requestApproval, context, interest, lifetime, port, read]);

    return React.useMemo(() => ({ state, reload, write }), [state, reload, write]);
}
