import * as React from 'react';

import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceEntry, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type {
    PluginUiResourceReference,
    PluginUiResourceSnapshot,
} from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { createPluginContextualResourceReadClient } from './pluginSurfaceResourceRead';
import { readPluginSurfaceResourceReference } from './pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient } from './pluginSurfaceResourceWatch';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { randomUUID } from '@/platform/randomUUID';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWidgetFrameResourceActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type PluginContextualResourceStore = ReturnType<typeof createPluginUiResourceStore>;

export type PluginContextualResourceStoreLease = Readonly<{
    store: PluginContextualResourceStore;
    dispose(): void;
    /** Retires a confirmed terminal target for every current consumer. */
    retire(): void;
}>;

export type PluginContextualResourceStoreOwner = Readonly<{
    /**
     * Acquires one captured exact Home/Account store for a host-stamped
     * binding. Callers cannot supply their own transport, cache, or Session
     * identity.
     */
    acquire(input: Readonly<{
        accountLifetime: ActiveServerAccountScopeLifetime;
        pluginId: string;
        machineId: string;
        serverId: string | null;
        expectedCallerOccurrenceId: string;
        context: PluginResourceContextV1;
    }>): PluginContextualResourceStoreLease | null;
}>;

type ResourceStoreConsumer = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    retirement: Readonly<{ dispose(): void }>;
}>;

type ResourceStoreEntry = {
    readonly store: PluginContextualResourceStore;
    readonly bindingFamilyKey: string;
    consumers: Set<ResourceStoreConsumer>;
    disposed: boolean;
};

export type PluginContextualResourceBinding = Parameters<PluginContextualResourceStoreOwner['acquire']>[0];

type ResourceStoreBinding = PluginContextualResourceBinding;

function accountBindingKey(input: ResourceStoreBinding): readonly [string, string] {
    // Account coordinates are the existing Account owner's identity. Including
    // them in this key prevents a brief A/B overlap
    // from sharing one contextual store; retirement removes the old entry
    // before a same-coordinate lifetime can be reused.
    return [input.accountLifetime.scope.serverId, input.accountLifetime.scope.accountId];
}

function resourceBindingKey(input: ResourceStoreBinding): string {
    return JSON.stringify([
        accountBindingKey(input),
        input.pluginId,
        input.machineId,
        input.serverId,
        input.expectedCallerOccurrenceId,
        input.context,
    ]);
}

/** The same target across projection generations; generation remains exact in the store key. */
function resourceBindingFamilyKey(input: ResourceStoreBinding): string {
    return JSON.stringify([
        accountBindingKey(input),
        input.pluginId,
        input.machineId,
        input.serverId,
        input.context,
    ]);
}

/** Host chrome mounts these stores; there is no plugin-authored surface id to name. */
const CONTEXTUAL_RESOURCE_SURFACE_ID = 'host:plugin-contextual-resource';

function createPluginContextualResourceStoreOwner(): PluginContextualResourceStoreOwner {
    // The captured exact Home/Account is the sharing boundary. An entry exists only
    // while one of its mounted consumers holds it; no Account-keyed outer map
    // and no zero-consumer retention survives navigation.
    const entries = new Map<string, ResourceStoreEntry>();

    const disposeEntry = (key: string, entry: ResourceStoreEntry): void => {
        if (entries.get(key) !== entry || entry.disposed) return;
        // Delete before stopping descendants so synchronous Account retirement
        // cannot reenter through a stale map key.
        entries.delete(key);
        entry.disposed = true;
        for (const consumer of entry.consumers) consumer.retirement.dispose();
        entry.consumers.clear();
        entry.store.dispose();
    };

    return Object.freeze({
        acquire(requestedBinding) {
            if (!requestedBinding.accountLifetime.isCurrent()) return null;
            if (requestedBinding.serverId !== null && !areServerProfileIdentifiersEquivalent(
                requestedBinding.accountLifetime.scope.serverId, requestedBinding.serverId,
            )) return null;
            const activeAccountLifetime = captureActiveServerAccountScopeLifetime();
            const accountLifetime = activeAccountLifetime?.isCurrent()
                && activeAccountLifetime.scope.serverId === requestedBinding.accountLifetime.scope.serverId
                && activeAccountLifetime.scope.accountId === requestedBinding.accountLifetime.scope.accountId
                ? activeAccountLifetime : requestedBinding.accountLifetime;
            // An Action's invocation lifetime may retire independently. The shared
            // active-Home transport belongs to the canonical Account. Exact other
            // Homes retain their already-admitted credential lifetimes below.
            const input = { ...requestedBinding, accountLifetime };

            const key = resourceBindingKey(input);
            const bindingFamilyKey = resourceBindingFamilyKey(input);
            // A new generation is an authoritative replacement, not an idle
            // cache policy. A still-mounted old consumer cannot keep bytes or
            // a long poll after the exact binding changes.
            for (const [otherKey, otherEntry] of [...entries]) {
                if (otherKey === key || otherEntry.bindingFamilyKey !== bindingFamilyKey) continue;
                disposeEntry(otherKey, otherEntry);
            }

            let entry = entries.get(key);
            if (!entry || entry.disposed) {
                let createdEntry: ResourceStoreEntry | null = null;
                const resource = Object.freeze({
                    machineId: input.machineId,
                    serverId: input.serverId,
                    expectedCallerOccurrenceId: input.expectedCallerOccurrenceId,
                    context: input.context,
                });
                const isCurrent = (): boolean => {
                    if (!createdEntry || createdEntry.disposed) return false;
                    for (const consumer of createdEntry.consumers) if (consumer.accountLifetime.isCurrent()) return true;
                    return false;
                };
                const client = Object.freeze({
                    ...createPluginContextualResourceReadClient({
                        pluginId: input.pluginId,
                        resource,
                        isCurrent,
                    }),
                    ...createPluginContextualResourceWatchClient({
                        pluginId: input.pluginId,
                        resource,
                        // Transport identity is bounded independently of context;
                        // Account and Resource authority stay in the binding above.
                        subscriptionIdPrefix: `contextual-resource:${randomUUID()}`,
                        isCurrent,
                    }),
                    // A contextual mount has no plugin-authored surface to route
                    // `hostApi.diagnostic` through, but its author still needs to
                    // learn when the store refused their Resource. Report into the
                    // one Plugin UI diagnostic sink the surface transport also uses.
                    diagnostic: (data: unknown) => {
                        logPluginSurfaceDiagnostic(
                            {
                                pluginId: input.pluginId,
                                contributionId: null,
                                surfaceId: CONTEXTUAL_RESOURCE_SURFACE_ID,
                            },
                            data,
                        );
                    },
                });
                createdEntry = {
                    // This contextual owner already owns the captured Account
                    // retirement callback below. The generic store retains
                    // only its read/watch lifecycle and receives currentness
                    // through the bound client, avoiding a duplicate lifetime
                    // registration for the same mounted binding.
                    store: createPluginUiResourceStore({
                        client,
                        pluginId: input.pluginId,
                    }),
                    bindingFamilyKey,
                    consumers: new Set(),
                    disposed: false,
                };
                entries.set(key, createdEntry);
                entry = createdEntry;
            }

            let released = false;
            let consumer: ResourceStoreConsumer | undefined;
            const release = (retire: boolean): void => {
                if (released) return;
                released = true;
                if (consumer) {
                    consumer.retirement.dispose();
                    entry!.consumers.delete(consumer);
                }
                if (retire) {
                    disposeEntry(key, entry!);
                    return;
                }
                if (entry!.consumers.size === 0) disposeEntry(key, entry!);
            };
            const retirement = accountLifetime.onRetire(() => release(false));
            if (released || !accountLifetime.isCurrent() || entry.disposed) {
                retirement.dispose();
                if (entry.consumers.size === 0) disposeEntry(key, entry);
                return null;
            }
            consumer = Object.freeze({ accountLifetime, retirement });
            entry.consumers.add(consumer);
            return Object.freeze({
                store: entry.store,
                dispose(): void {
                    release(false);
                },
                retire(): void {
                    release(true);
                },
            });
        },
    });
}

const PluginContextualResourceStoreContext = React.createContext<PluginContextualResourceStoreOwner | null>(null);
const activeAccountResourceStoreOwner = createPluginContextualResourceStoreOwner();

/** Shares the existing exact-binding owner with host mounts and Account Actions. */
export function acquirePluginContextualResourceStore(binding: PluginContextualResourceBinding): PluginContextualResourceStoreLease | null {
    return activeAccountResourceStoreOwner.acquire(binding);
}

/** A private mount facade: declaration scope selects an existing exact-context entry. */
export function createPluginDeclaredResourceStore(input: Omit<PluginContextualResourceBinding, 'context'> & Readonly<{
    resourcesById: PluginUiProjectionModel['resourcesById'];
    /** Undefined is unknown; a complete empty publication withdraws the ordinary namespace. */
    resourceDeclarationsComplete?: boolean;
    sessionId?: string;
    surfaceContext?: Extract<PluginResourceContextV1, { kind: 'surface' }>;
    createFallbackStore?: () => PluginUiResourceStore;
}>): (PluginUiResourceStore & Readonly<{
    reconcile(): void;
    hasDeclaredNamespace(): boolean;
    readNamespaceKey(): string;
    onDeclaredNamespaceAdmission(listener: () => void): () => void;
}>) | null {
    const readDeclarations = () => Object.values(input.resourcesById).filter(row => row.pluginId === input.pluginId);
    const isScopedNamespace = (rows: ReturnType<typeof readDeclarations>) => (
        input.resourceDeclarationsComplete === true && rows.every(row => row.scope !== undefined)
    );
    // Preserve the incumbent ordinary transport until scoped declarations
    // actually arrive. Once admitted, their withdrawal cannot reopen it.
    let hasDeclaredNamespace = isScopedNamespace(readDeclarations());
    let fallbackStore: PluginUiResourceStore | null = null;
    const namespaceListeners = new Set<() => void>();
    const entries = new Map<string, Readonly<{
        localId: string;
        contract: string | null;
        entry: PluginUiResourceEntry;
        retire(code: string): void;
    }>>();
    let disposed = false;
    const unavailableSnapshot = (code: string): PluginUiResourceSnapshot => Object.freeze({
        freshness: 'unknown', pending: 'idle', subscription: 'ended', error: { code, message: code },
    });
    const surfaceRetired = unavailableSnapshot('plugin_surface_retired');
    const declarationWithdrawn = unavailableSnapshot('plugin_resource_not_found');
    const unavailableEntry = (snapshot: PluginUiResourceSnapshot): PluginUiResourceEntry => Object.freeze({
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        refresh: async () => snapshot,
    });
    // Resource hooks render failures as snapshots, not render-time exceptions.
    const failures = {
        plugin_surface_retired: unavailableEntry(surfaceRetired),
        plugin_resource_not_found: unavailableEntry(declarationWithdrawn),
        plugin_resource_context_unavailable: unavailableEntry(unavailableSnapshot('plugin_resource_context_unavailable')),
    };
    const fail = (code: keyof typeof failures) => failures[code];
    const contractKey = (row: PluginUiProjectionModel['resourcesById'][string]) => {
        // Canonical projected Resource fields, excluding host publication
        // metadata and arbitrary UI projection extensions.
        const { id, pluginId, occurrenceId, executionOrigin, resourceKind, path,
            scope, connectedAccountPurposes, digest, contentType } = row;
        return stableJsonStringify({ id, pluginId, occurrenceId, executionOrigin, resourceKind, path,
            scope, connectedAccountPurposes, digest, contentType });
    };
    const reconcile = () => {
        const declarations = readDeclarations();
        const admittedNamespace = !hasDeclaredNamespace && isScopedNamespace(declarations);
        hasDeclaredNamespace ||= isScopedNamespace(declarations);
        for (const [key, mounted] of entries) {
            const declaration = declarations.find(row => row.id === mounted.localId);
            if (!disposed && input.accountLifetime.isCurrent()
                && (mounted.contract === null ? !hasDeclaredNamespace
                    : declaration && mounted.contract === contractKey(declaration))) continue;
            entries.delete(key);
            mounted.retire(disposed || !input.accountLifetime.isCurrent() ? 'plugin_surface_retired' : 'plugin_resource_not_found');
        }
        if (disposed || hasDeclaredNamespace) {
            fallbackStore?.dispose();
            fallbackStore = null;
        }
        if (admittedNamespace) {
            const listeners = [...namespaceListeners];
            namespaceListeners.clear();
            for (const listener of listeners) listener();
        }
    };
    return Object.freeze({
        reconcile,
        hasDeclaredNamespace: () => hasDeclaredNamespace || isScopedNamespace(readDeclarations()),
        readNamespaceKey: () => stableJsonStringify([
            hasDeclaredNamespace || isScopedNamespace(readDeclarations()),
            readDeclarations().map(contractKey).sort(),
        ]),
        onDeclaredNamespaceAdmission(listener) {
            if (disposed || hasDeclaredNamespace || isScopedNamespace(readDeclarations())) return () => {};
            namespaceListeners.add(listener);
            return () => { namespaceListeners.delete(listener); };
        },
        getEntry(resource) {
            reconcile();
            if (disposed || !input.accountLifetime.isCurrent()) return fail('plugin_surface_retired');
            const reference = readPluginSurfaceResourceReference(input.pluginId, resource);
            if (!reference || reference.pluginId !== input.pluginId) return fail('plugin_resource_not_found');
            const declaration = hasDeclaredNamespace ? readDeclarations().find(row => row.id === reference.localId) : undefined;
            if (hasDeclaredNamespace && !declaration) return fail('plugin_resource_not_found');
            const key = pluginUiResourceReferenceKey(reference, input.pluginId);
            const mounted = entries.get(key);
            if (mounted) return mounted.entry;
            let lease: PluginContextualResourceStoreLease | null = null;
            let shared: PluginUiResourceEntry;
            if (declaration) {
                const context: PluginResourceContextV1 | undefined = declaration.scope === 'global' ? { kind: 'global' }
                    : declaration.scope === 'session' && input.sessionId ? { kind: 'session', sessionId: input.sessionId }
                    : declaration.scope === 'surface' ? input.surfaceContext : undefined;
                if (!context) return fail('plugin_resource_context_unavailable');
                lease = acquirePluginContextualResourceStore({ ...input, context });
                if (!lease) return fail('plugin_surface_retired');
                try { shared = lease.store.getEntry(reference); }
                catch (error) { lease.dispose(); throw error; }
            } else {
                fallbackStore ??= input.createFallbackStore?.() ?? null;
                if (!fallbackStore) return fail('plugin_resource_not_found');
                shared = fallbackStore.getEntry(reference);
            }
            // The underlying bytes/watch remain shared. Only this mount's
            // declaration authority is withdrawn; another consumer can retain
            // the shared entry without exposing it through this old facade.
            let retired: PluginUiResourceSnapshot | null = null;
            const contract = declaration ? contractKey(declaration) : null;
            const subscriptions = new Set<Readonly<{ listener(): void; release(): void }>>();
            const snapshot = (): PluginUiResourceSnapshot => {
                if (retired) return retired;
                if (disposed || !input.accountLifetime.isCurrent()) return surfaceRetired;
                const currentDeclarations = readDeclarations();
                const current = currentDeclarations.find(row => row.id === reference.localId);
                // Snapshot reads may run while React renders. Hide withdrawn
                // data now; committed reconciliation releases and notifies.
                const admitted = contract === null ? !hasDeclaredNamespace && !isScopedNamespace(currentDeclarations)
                    : current && contractKey(current) === contract;
                return admitted ? shared.getSnapshot() : declarationWithdrawn;
            };
            const entry: PluginUiResourceEntry = Object.freeze({
                getSnapshot: snapshot,
                subscribe(listener, live) {
                    reconcile();
                    if (retired) return () => {};
                    const subscription = { listener, release: shared.subscribe(listener, live) };
                    subscriptions.add(subscription);
                    return () => { subscriptions.delete(subscription); subscription.release(); };
                },
                async refresh() {
                    reconcile();
                    if (retired) return retired;
                    await shared.refresh();
                    return snapshot();
                },
            });
            entries.set(key, { localId: reference.localId, contract, entry,
                retire(code) {
                    if (retired) return;
                    retired = code === 'plugin_surface_retired' ? surfaceRetired : declarationWithdrawn;
                    const previous = [...subscriptions];
                    subscriptions.clear();
                    for (const subscription of previous) subscription.release();
                    lease?.dispose();
                    for (const subscription of previous) subscription.listener();
                } });
            return entry;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            reconcile();
            namespaceListeners.clear();
        },
    });
}

/**
 * A mounted access boundary for concurrent exact contextual Resource
 * consumers. It owns no asynchronous provider cleanup: each consumer release
 * synchronously disposes the final store, which also makes StrictMode replay
 * an ordinary acquire/release sequence rather than a special fenced lifetime.
 */
export function PluginContextualResourceStoreProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const nearestOwner = React.useContext(PluginContextualResourceStoreContext);
    return (
        <PluginContextualResourceStoreContext.Provider value={nearestOwner ?? activeAccountResourceStoreOwner}>
            {props.children}
        </PluginContextualResourceStoreContext.Provider>
    );
}

/** Missing provider fails closed; it never recreates a consumer-local store. */
export function usePluginContextualResourceStoreOwner(): PluginContextualResourceStoreOwner | null {
    return React.useContext(PluginContextualResourceStoreContext);
}

function resourceRenderKey(resource: PluginUiResourceReference, pluginId: string): string {
    return pluginUiResourceReferenceKey(resource, pluginId);
}

type AcquiredPluginContextualResource = Readonly<{
    owner: PluginContextualResourceStoreOwner;
    bindingKey: string;
    lease: PluginContextualResourceStoreLease;
}>;

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/**
 * Reads one exact contextual Resource through the mounted provider's existing
 * store. This is deliberately schema-agnostic: a consumer owns its content
 * type decoder and any last-known-good presentation policy, while this
 * boundary owns only lease, currentness, cancellation, and subscription.
 */
export function PluginContextualResourceState<TSelected = PluginUiResourceSnapshot | null>(props: Readonly<{
    binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    /** Demand follows the containing host; identity and retained data keep the existing lease. */
    active?: boolean;
    /** Select at the store subscription so summary consumers do not render for detail-only changes. */
    select?: (snapshot: PluginUiResourceSnapshot | null) => TSelected;
    /** `refresh` re-reads through the same leased entry (a Retry); it settles even on failure or retirement. */
    children: (snapshot: TSelected, controls: PluginContextualResourceControls) => React.ReactNode;
}>): React.ReactElement | null {
    const owner = usePluginContextualResourceStoreOwner();
    const presented = useLayoutPresentationActive();
    const bindingKey = resourceBindingKey(props.binding);
    const resourceKey = resourceRenderKey(props.resource, props.binding.pluginId);
    // Callers commonly reconstruct a `{ pluginId, localId }` reference during
    // their own projection. Keep the generic store entry stable by its exact
    // Resource identity, not that incidental wrapper identity.
    const stableResource = React.useMemo(() => props.resource, [resourceKey]);
    const currentRef = React.useRef(props.isCurrent);
    currentRef.current = props.isCurrent;
    const selectorRef = React.useRef(props.select);
    selectorRef.current = props.select;
    const currentAtRender = !isAbortSignalAborted(props.signal) && currentRef.current?.() !== false;
    const [acquired, setAcquired] = React.useState<AcquiredPluginContextualResource | null>(null);

    React.useEffect(() => {
        if (owner === null || !currentAtRender) {
            setAcquired((previous) => previous?.bindingKey === bindingKey ? null : previous);
            return;
        }

        const lease = owner.acquire(props.binding);
        if (lease === null || isAbortSignalAborted(props.signal) || currentRef.current?.() === false) {
            lease?.dispose();
            setAcquired((previous) => previous?.bindingKey === bindingKey ? null : previous);
            return;
        }

        const next = Object.freeze({ owner, bindingKey, lease });
        setAcquired(next);
        const release = (): void => {
            lease.dispose();
            setAcquired((previous) => previous?.lease === lease ? null : previous);
        };
        const onAbort = (): void => { release(); };
        props.signal?.addEventListener('abort', onAbort, { once: true });
        const accountRetirement = props.binding.accountLifetime.onRetire(release);
        return () => {
            props.signal?.removeEventListener('abort', onAbort);
            accountRetirement.dispose();
            lease.dispose();
        };
    }, [bindingKey, currentAtRender, owner, props.binding.accountLifetime, props.signal]);

    const entry = React.useMemo(() => {
        if (
            acquired === null
            || acquired.owner !== owner
            || acquired.bindingKey !== bindingKey
            || !currentAtRender
        ) {
            return null;
        }
        return acquired.lease.store.getEntry(stableResource);
    }, [acquired, bindingKey, currentAtRender, owner, stableResource]);
    const subscribe = React.useCallback(
        (listener: () => void): (() => void) => presented && props.active !== false ? entry?.subscribe(listener, true) ?? (() => {}) : () => {},
        [entry, presented, props.active],
    );
    const getResourceSnapshot = React.useCallback(
        (): PluginUiResourceSnapshot | null => (
            currentRef.current?.() === false || props.signal?.aborted === true
                ? null
                : entry?.getSnapshot() ?? null
        ),
        [entry, props.signal],
    );
    const getSnapshot = React.useCallback((): TSelected => {
        const snapshot = getResourceSnapshot();
        // Without a selector the public default is the unchanged Resource snapshot.
        return selectorRef.current ? selectorRef.current(snapshot) : snapshot as TSelected;
    }, [getResourceSnapshot]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useWidgetFrameResourceActivity(presented && props.active !== false && getResourceSnapshot()?.pending === 'refresh');
    const controls = React.useMemo<PluginContextualResourceControls>(() => ({
        refresh: async () => { if (entry && currentRef.current?.() !== false) await entry.refresh(); },
    }), [entry]);

    return <>{props.children(snapshot, controls)}</>;
}

export type PluginContextualResourceControls = Readonly<{ refresh: () => Promise<void> }>;
