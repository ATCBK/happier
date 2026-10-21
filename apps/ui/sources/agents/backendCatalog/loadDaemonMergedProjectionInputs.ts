import {
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionDescribe,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionFailureReason,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineContributionRegistryProjectionScopeKey } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import {
    forgetPluginUiProjectionAdmissionSnapshot,
    pluginUiProjectionAdmissionTargetKey,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    readProjectedAgentUiBehaviorDescriptors,
    type PluginProjectionDiagnostic,
    type PluginProjectionEntry,
} from './daemonContributionRegistryProjectionAdapters';
import {
    clearProjectedAgentUiBehaviorDescriptors,
    publishProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from './mergedProjectionTypes';
import type {
    DaemonContributionRegistryProjectionAutomationEligibleEventsV1,
    DaemonPluginUiComposerSurfaceCatalogEntryV1,
    PluginProjectionV2,
} from '@happier-dev/protocol';

import { getPreferredLanguage } from '@/text';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';

export type DaemonMergedProjectionInputs = Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    discoveredBackendIds: readonly string[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    /** One daemon-selected Composer renderer catalog carried by this projection snapshot. */
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    /** Current cold Event-automation composer facts carried by the same daemon projection. */
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>;

type ProjectionCacheResult = (
    | Readonly<{ kind: 'ready'; fetchedAtMs: number; inputs: DaemonMergedProjectionInputs }>
    | Readonly<{ kind: 'unsupported'; fetchedAtMs: number }>
    | Readonly<{
        kind: 'error';
        fetchedAtMs: number;
        /** Why the latest read failed; the last good inputs stay available. */
        reason: MachineContributionRegistryProjectionFailureReason;
        retryAttempt: number;
        retryAtMs: number;
        inputs?: DaemonMergedProjectionInputs;
    }>
);
type ProjectionCacheEntry = Readonly<{
    projectionRevision: number;
    accountScope?: ServerAccountScope | null;
    /** The locale whose narrowed translation bundles this answer carries. */
    locale: string;
    /** The exact routed Home credential that authorized this projection. */
    accountCurrentness?: Pick<ActiveServerAccountScopeLifetime, 'isCurrent' | 'onRetire'> & Readonly<{
        retainReader(reader: ActiveServerAccountScopeLifetime): void;
    }>;
}> & ProjectionCacheResult;
type ReusableProjectionCacheEntry = Extract<ProjectionCacheEntry, { kind: 'ready' | 'unsupported' }>;

/**
 * The one UI owner of each machine's daemon projection. Every reader — the
 * AppShell plugin UI currentness, `useDaemonMergedProjectionInputs`, and the
 * direct callers — goes through this cache and its single in-flight request
 * per machine scope, projection revision and requested locale.
 */
const PROJECTION_CACHE = new Map<string, ProjectionCacheEntry>();
type ProjectionSummarySubscription = Readonly<{
    listeners: Set<() => void>;
    notify(): void;
    dispose(): void;
}>;
const PROJECTION_SUMMARY_SUBSCRIPTIONS = new Map<string, ProjectionSummarySubscription>();

export type DaemonMergedProjectionSummary = Readonly<{
    inputs: (Pick<DaemonMergedProjectionInputs, 'mergedBackendProjectionById' | 'mergedProviderProjectionById'> & Readonly<{
        agentDeclarationsById: PluginProjectionV2['agentsById'] | null;
    }>) | null;
    current: boolean;
}>;
const EMPTY_PROJECTION_SUMMARY: DaemonMergedProjectionSummary = Object.freeze({ inputs: null, current: false });
const PROJECTION_SUMMARIES = new WeakMap<ProjectionCacheEntry, Readonly<{
    current: DaemonMergedProjectionSummary;
    stale: DaemonMergedProjectionSummary;
}>>();

/** Chrome observes this owner's published summary; it never resolves credentials or describes a daemon. */
export function readDaemonMergedProjectionSummary(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): DaemonMergedProjectionSummary {
    const entry = readCachedDaemonMergedProjectionCacheEntry(params);
    if (!entry || !entry.accountCurrentness || (entry.kind !== 'ready' && entry.kind !== 'error') || !entry.inputs) {
        return EMPTY_PROJECTION_SUMMARY;
    }
    let summaries = PROJECTION_SUMMARIES.get(entry);
    if (!summaries) {
        const inputs = Object.freeze({
            mergedBackendProjectionById: entry.inputs.mergedBackendProjectionById,
            mergedProviderProjectionById: entry.inputs.mergedProviderProjectionById,
            agentDeclarationsById: entry.inputs.pluginProjectionV2?.agentsById ?? null,
        });
        summaries = Object.freeze({ current: Object.freeze({ inputs, current: true }), stale: Object.freeze({ inputs, current: false }) });
        PROJECTION_SUMMARIES.set(entry, summaries);
    }
    return entry.kind === 'ready'
        && entry.projectionRevision === getMachineContributionRegistryProjectionRevision({
            machineId: normalizeKeyPart(params.machineId), serverId: normalizeKeyPart(params.serverId) || null,
        })
        && entry.locale === getPreferredLanguage()
        ? summaries.current : summaries.stale;
}

/** One upstream subscription and lifetime observer per cache scope, shared by every row. */
export function subscribeDaemonMergedProjectionSummary(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>, listener: () => void): () => void {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return () => {};
    const serverId = normalizeKeyPart(params.serverId) || null;
    const key = buildCacheKey(machineId, serverId);
    let subscription = PROJECTION_SUMMARY_SUBSCRIPTIONS.get(key);
    if (!subscription) {
        const listeners = new Set<() => void>();
        let observedEntry: ProjectionCacheEntry | null = null;
        let retirement: Readonly<{ dispose(): void }> | undefined;
        const notify = () => {
            const entry = currentProjectionCacheEntry(key);
            if (entry !== observedEntry) {
                retirement?.dispose();
                observedEntry = entry;
                retirement = entry?.accountCurrentness?.onRetire(notify);
            }
            for (const consumer of listeners) consumer();
        };
        const unsubscribe = subscribeMachineContributionRegistryProjectionInvalidation({ machineId, serverId }, notify);
        subscription = { listeners, notify, dispose: () => { unsubscribe(); retirement?.dispose(); } };
        PROJECTION_SUMMARY_SUBSCRIPTIONS.set(key, subscription);
        notify();
    }
    subscription.listeners.add(listener);
    const captured = subscription;
    return () => {
        captured.listeners.delete(listener);
        if (captured.listeners.size === 0) {
            captured.dispose();
            if (PROJECTION_SUMMARY_SUBSCRIPTIONS.get(key) === captured) PROJECTION_SUMMARY_SUBSCRIPTIONS.delete(key);
        }
    };
}
const DEFAULT_PROJECTION_STALE_MS = 60_000;
// Preserve the incumbent transient burst and 30 s recovery cadence. Attempts
// belong to the shared Machine question, not each mounted reader's timer.
const PROJECTION_RETRY_BACKOFF_MS = [250, 1_000, 2_500, 5_000, 30_000] as const;

export function readDaemonMergedProjectionRetryDelayMs(entry?: ProjectionCacheEntry | null): number {
    return entry?.kind === 'error'
        ? Math.max(0, entry.retryAtMs - Date.now())
        : PROJECTION_RETRY_BACKOFF_MS[0];
}
type ProjectionRequest = Readonly<{
    revision: number;
    locale: string;
    /** The Account it reads for; a successor Account never joins it. */
    accountScope: ServerAccountScope | null;
    /**
     * Every lifetime handle waiting on it. Readers of one Account hold separate
     * handles (one per credential-scope hook), so the answer is published while
     * any of them is still current, not only while the issuer is.
     */
    wait(reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal): Promise<ProjectionCacheEntry | null>;
}>;
const LATEST_PROJECTION_REQUEST = new Map<string, ProjectionRequest>();

export function clearDaemonMergedProjectionCacheForTests(): void {
    PROJECTION_CACHE.clear();
    for (const subscription of PROJECTION_SUMMARY_SUBSCRIPTIONS.values()) subscription.notify();
    clearProjectedAgentUiBehaviorDescriptors();
    LATEST_PROJECTION_REQUEST.clear();
}

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function buildCacheKey(
    machineId: string,
    serverId: string | null | undefined,
): string {
    return machineContributionRegistryProjectionScopeKey({
        serverId: normalizeKeyPart(serverId) || null,
        machineId: normalizeKeyPart(machineId),
    });
}

export function entryIsFresh(entry: Readonly<{ fetchedAtMs: number }>, staleMs: number): boolean {
    const ageMs = Date.now() - entry.fetchedAtMs;
    return ageMs >= 0 && ageMs <= staleMs;
}

function currentProjectionCacheEntry(cacheKey: string): ProjectionCacheEntry | null {
    const entry = PROJECTION_CACHE.get(cacheKey) ?? null;
    if (entry?.accountCurrentness && !entry.accountCurrentness.isCurrent()) {
        PROJECTION_CACHE.delete(cacheKey);
        return null;
    }
    return entry;
}

export function readCachedDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): ProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }
    return currentProjectionCacheEntry(buildCacheKey(machineId, normalizeKeyPart(params.serverId) || null));
}

/** The single authoritative reuse decision for every projection reader. */
export function readReusableDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    staleMs?: number;
}>): ReusableProjectionCacheEntry | null {
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) return null;
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!accountLifetime?.isCurrent()) return null;
    const serverId = normalizeKeyPart(params.serverId) || null;
    const cached = currentProjectionCacheEntry(buildCacheKey(machineId, serverId));
    const staleMs = params.staleMs ?? DEFAULT_PROJECTION_STALE_MS;
    if (
        !cached || cached.kind === 'error'
        || !entryIsFresh(cached, staleMs)
        || cached.projectionRevision !== getMachineContributionRegistryProjectionRevision({ machineId, serverId })
        || cached.locale !== getPreferredLanguage()
        || (cached.accountScope !== accountLifetime.scope
            && !areServerAccountScopesEqual(cached.accountScope ?? null, accountLifetime.scope))
    ) return null;
    // A settled answer belongs to every current reader that reuses it, just
    // as an in-flight answer does. Retiring its issuer cannot evict a sibling's
    // projection or make that sibling describe the same question again.
    cached.accountCurrentness?.retainReader(accountLifetime);
    return cached;
}

function toInputs(params: Readonly<{
    mergedProviderProjectionById: Readonly<Record<string, MergedProviderProjectionEntry>>;
    mergedBackendProjectionById: Readonly<Record<string, MergedBackendProjectionEntry>>;
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2 | null;
    composerSurfaceCatalog?: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    automationEligibleEvents?: DaemonContributionRegistryProjectionAutomationEligibleEventsV1;
    registryDiagnostics: readonly PluginProjectionDiagnostic[];
}>): DaemonMergedProjectionInputs {
    return {
        mergedProviderProjectionById: params.mergedProviderProjectionById,
        mergedBackendProjectionById: params.mergedBackendProjectionById,
        discoveredBackendIds: Object.keys(params.mergedBackendProjectionById ?? {}),
        pluginProjectionById: params.pluginProjectionById,
        pluginProjectionV2: params.pluginProjectionV2,
        ...(params.composerSurfaceCatalog === undefined
            ? {}
            : { composerSurfaceCatalog: params.composerSurfaceCatalog }),
        ...(params.automationEligibleEvents === undefined
            ? {}
            : { automationEligibleEvents: params.automationEligibleEvents }),
        registryDiagnostics: params.registryDiagnostics,
    };
}

export async function loadDaemonMergedProjectionCacheEntry(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    /** Exact routed Account lifetime; required for background descriptor publication. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** App-shell readers may reuse the same fresh, Account-qualified projection. */
    reuseFreshReady?: boolean;
    /** Automatic recovery: share its cadence, or false to refresh its authority.
     * Omit for an explicit one-shot read with ordinary fresh/rejection semantics. */
    shareRetryCadence?: boolean;
    signal?: AbortSignal;
}>): Promise<ProjectionCacheEntry | null> {
    if (params.signal?.aborted) return null;
    const accountLifetime = params.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (accountLifetime && !accountLifetime.isCurrent()) return null;
    const locale = getPreferredLanguage();
    const cacheKey = buildCacheKey(params.machineId, params.serverId);
    // The canonical per-machine projection scope. Its revision advances on
    // socket reconnect, on an explicit invalidation, and on a known daemon
    // replacement. Initial inventory only discovers the endpoint a successful
    // read already asked; it does not make that answer stale. The machine
    // writer owns actual registry changes through this revision.
    const projectionScope = {
        machineId: normalizeKeyPart(params.machineId),
        serverId: normalizeKeyPart(params.serverId) || null,
    };
    const requestRevision = getMachineContributionRegistryProjectionRevision(projectionScope);
    const accountScope = accountLifetime?.scope ?? null;
    const matchesRequest = (entry: ProjectionCacheEntry) => entry.projectionRevision === requestRevision
        && entry.locale === locale && (entry.accountScope === accountScope
            || areServerAccountScopesEqual(entry.accountScope ?? null, accountScope));
    const incumbentRequest = LATEST_PROJECTION_REQUEST.get(cacheKey);
    if (
        incumbentRequest?.revision === requestRevision
        && incumbentRequest.locale === locale
        && (incumbentRequest.accountScope === accountScope
            || areServerAccountScopesEqual(incumbentRequest.accountScope, accountScope))
    ) {
        return await incumbentRequest.wait(accountLifetime, params.signal);
    }
    const previousAttempt = params.shareRetryCadence ? currentProjectionCacheEntry(cacheKey) : null;
    if (params.shareRetryCadence && previousAttempt?.kind === 'error' && matchesRequest(previousAttempt)
        && Date.now() < previousAttempt.retryAtMs) {
        if (accountLifetime) previousAttempt.accountCurrentness?.retainReader(accountLifetime);
        return previousAttempt;
    }
    if (params.reuseFreshReady === true) {
        const cached = readReusableDaemonMergedProjectionCacheEntry({
            machineId: params.machineId,
            serverId: params.serverId,
            accountLifetime,
        });
        if (cached?.kind === 'ready') {
            return accountLifetime && !accountLifetime.isCurrent() ? null : cached;
        }
    }
    const readers = new Set<ActiveServerAccountScopeLifetime>(accountLifetime ? [accountLifetime] : []);
    const readerObservers = new Set<(reader: ActiveServerAccountScopeLifetime) => void>();
    const retainReader = (reader: ActiveServerAccountScopeLifetime) => {
        for (const previous of readers) {
            if (!previous.isCurrent()) readers.delete(previous);
        }
        if (readers.has(reader)) return;
        readers.add(reader);
        for (const observe of readerObservers) observe(reader);
    };
    const routedAccount = accountLifetime
        && (!params.serverId || areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, params.serverId))
        ? {
            scope: accountLifetime.scope,
            currentness: Object.freeze({
                isCurrent: () => [...readers].some((reader) => reader.isCurrent()),
                retainReader,
                onRetire: (cancel: () => void) => {
                    const retirements = new Set<Readonly<{ dispose(): void }>>();
                    const observe = (reader: ActiveServerAccountScopeLifetime) => {
                        if (!reader.isCurrent()) return;
                        let retirement: Readonly<{ dispose(): void }> | null = null;
                        retirement = reader.onRetire(() => {
                            readers.delete(reader);
                            if (retirement) {
                                retirements.delete(retirement);
                                retirement.dispose();
                            }
                            cancel();
                        });
                        retirements.add(retirement);
                    };
                    readerObservers.add(observe);
                    for (const reader of readers) observe(reader);
                    return Object.freeze({ dispose: () => {
                        readerObservers.delete(observe);
                        for (const retirement of retirements) retirement.dispose();
                    } });
                },
            }),
        }
        : null;
    // Every answer is published tagged with the revision it answered, unless a
    // newer one is already cached. A read never waits on a newer read: when the
    // daemon's state keeps advancing, waiting would never settle.
    const publish = (entry: ProjectionCacheResult & Readonly<{ projectionRevision: number }>): ProjectionCacheEntry => {
        const current = currentProjectionCacheEntry(cacheKey);
        if (current !== null && current.projectionRevision > entry.projectionRevision) return current;
        const published = Object.freeze({
            ...entry,
            accountScope,
            locale,
            ...(routedAccount ? { accountCurrentness: routedAccount.currentness } : {}),
        });
        // A former locale may settle after the current one. It still answers
        // its reader, but never replaces the current locale's shared cache.
        if (locale === getPreferredLanguage()) {
            PROJECTION_CACHE.set(cacheKey, published);
            PROJECTION_SUMMARY_SUBSCRIPTIONS.get(cacheKey)?.notify();
        }
        return published;
    };
    const requestAbort = new AbortController();
    const publishFailure = (reason: MachineContributionRegistryProjectionFailureReason, fetchedAtMs: number) => {
        const previous = currentProjectionCacheEntry(cacheKey);
        const retryAttempt = params.shareRetryCadence && previous?.kind === 'error' && matchesRequest(previous)
            ? previous.retryAttempt + 1 : 0;
        return publish({ kind: 'error', fetchedAtMs, projectionRevision: requestRevision, reason, retryAttempt,
            retryAtMs: Date.now() + PROJECTION_RETRY_BACKOFF_MS[
                Math.min(retryAttempt, PROJECTION_RETRY_BACKOFF_MS.length - 1)
            ]!,
            ...((previous?.kind === 'ready' || previous?.kind === 'error') && previous.inputs
                ? { inputs: previous.inputs } : {}),
        });
    };
    const fetchedAtMs = Date.now();
    const request = (async (): Promise<ProjectionCacheEntry | null> => {
        const res = await machineContributionRegistryProjectionDescribe(params.machineId, {
            ...(params.serverId ? { serverId: params.serverId } : {}),
            ...(accountLifetime ? { accountLifetime } : {}),
            signal: requestAbort.signal,
        });
        if (requestAbort.signal.aborted) return null;
        if (routedAccount && !routedAccount.currentness.isCurrent()) return null;
        if (res.supported !== true) {
            // Retiring retained custody is destructive, so only the endpoint
            // that is still current may do it.
            if (
                res.reason === 'not-supported'
                && getMachineContributionRegistryProjectionRevision(projectionScope) === requestRevision
            ) {
                // Method-not-found is a machine fact: the endpoint that answered
                // does not serve the projection. Retire the retained entry for
                // that machine so a later offline process cannot restore what
                // the daemon disclaimed. A transient failure keeps custody.
                forgetPluginUiProjectionAdmissionSnapshot({
                    scope: accountLifetime?.scope ?? null,
                    targetKey: pluginUiProjectionAdmissionTargetKey(projectionScope),
                });
            }
            return res.reason === 'not-supported'
                ? publish({ kind: 'unsupported', fetchedAtMs, projectionRevision: requestRevision })
                : publishFailure(res.reason, fetchedAtMs);
        }

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(res.projection);
        // The machine-wide read sees every installed Agent, so it owns this
        // machine's descriptor set — unless a newer answer already replaced it.
        const newerPublished = currentProjectionCacheEntry(cacheKey);
        if (newerPublished !== null && newerPublished.projectionRevision > requestRevision) return newerPublished;
        if (routedAccount && locale === getPreferredLanguage()) {
            publishProjectedAgentUiBehaviorDescriptors({
                machineId: projectionScope.machineId,
                accountScope: routedAccount.scope,
                accountLifetime: routedAccount.currentness,
                descriptorsByAgentId: readProjectedAgentUiBehaviorDescriptors(adapted.mergedProviderProjectionById),
                pluginUiProjection: normalizePluginUiProjection(res.projection),
                locale,
            });
        }
        return publish({
            kind: 'ready',
            fetchedAtMs,
            projectionRevision: requestRevision,
            inputs: toInputs({
                ...adapted,
                pluginProjectionV2: res.projection,
                ...(res.composerSurfaceCatalog === undefined
                    ? {}
                    : { composerSurfaceCatalog: res.composerSurfaceCatalog }),
                ...(res.automationEligibleEvents === undefined
                    ? {}
                    : { automationEligibleEvents: res.automationEligibleEvents }),
            }),
        });
    })().catch((error: unknown) => {
        // Automatic recovery owns failures after transport normalization too.
        // Explicit one-shot callers retain their ordinary rejection contract.
        if (params.shareRetryCadence === undefined) throw error;
        if (requestAbort.signal.aborted || (routedAccount && !routedAccount.currentness.isCurrent())) return null;
        return publishFailure('error', fetchedAtMs);
    });
    let waitingReaders = 0;
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const forget = () => {
        if (LATEST_PROJECTION_REQUEST.get(cacheKey) === requestOwner) LATEST_PROJECTION_REQUEST.delete(cacheKey);
    };
    const requestOwner: ProjectionRequest = Object.freeze({
        revision: requestRevision,
        locale,
        accountScope,
        wait: async (reader: ActiveServerAccountScopeLifetime | null, signal?: AbortSignal) => {
            if (reader) retainReader(reader);
            waitingReaders++;
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                if (--waitingReaders === 0 && !settled) {
                    forget();
                    requestAbort.abort();
                }
            };
            let onAbort: (() => void) | undefined;
            let retirement: Readonly<{ dispose(): void }> | undefined;
            try {
                if (signal?.aborted || (reader && !reader.isCurrent())) return null;
                return await new Promise<ProjectionCacheEntry | null>((resolve, reject) => {
                    onAbort = () => { release(); resolve(null); };
                    signal?.addEventListener('abort', onAbort, { once: true });
                    retirement = reader?.onRetire(onAbort);
                    void request.then(resolve, reject);
                });
            } finally {
                if (onAbort) signal?.removeEventListener('abort', onAbort);
                retirement?.dispose();
                release();
            }
        },
    });
    LATEST_PROJECTION_REQUEST.set(cacheKey, requestOwner);
    void request.then(forget, forget);
    return await requestOwner.wait(accountLifetime, params.signal);
}

/**
 * Returns this machine's current projection inputs, reusing a ready entry
 * younger than `staleMs` for the current projection revision.
 */
export async function loadDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    staleMs?: number;
    /** Exact routed Account lifetime; background Home descriptors never borrow focus. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    signal?: AbortSignal;
}>): Promise<DaemonMergedProjectionInputs | null> {
    if (params.signal?.aborted) return null;
    const machineId = normalizeKeyPart(params.machineId);
    if (!machineId) {
        return null;
    }

    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : DEFAULT_PROJECTION_STALE_MS;
    const cached = readReusableDaemonMergedProjectionCacheEntry({
        machineId,
        serverId: serverId || null,
        accountLifetime: params.accountLifetime,
        staleMs,
    });
    if (cached?.kind === 'ready') {
        return cached.inputs;
    }

    const entry = await loadDaemonMergedProjectionCacheEntry({
        machineId,
        signal: params.signal,
        ...(serverId ? { serverId } : {}),
        ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
    });
    return entry?.kind === 'ready' ? entry.inputs : null;
}
