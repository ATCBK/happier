import {
    getConnectedServiceQuotaSnapshotSealed,
    requestConnectedServiceQuotaSnapshotRefresh,
} from '@/sync/api/account/apiConnectedServicesQuotasV2';
import {
    getConnectedServiceQuotaSnapshotPlain,
    requestConnectedServiceQuotaSnapshotRefreshV3,
} from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { openConnectedServiceQuotaViewSnapshot } from '@/sync/domains/connectedServices/openConnectedServiceQuotaViewSnapshot';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { getUsageProjectionNextReadAtMs, observeUsageProjection } from '@/sync/api/account/usageQueryInvalidation';
import {
    connectedServiceQuotaRecoveryCreditConsume,
} from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import { sanitizeEndpointErrorMessage } from '@/sync/runtime/connectivity/sanitizeEndpointErrorMessage';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type {
    ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import type { CredentialScopedAccountMode } from './useCredentialScopedAccountModeResolver';
import type {
    BuiltInLegacyConnectedAccountOperation,
    ConnectedServiceId,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import { t } from '@/text';

/**
 * Shared, module-level loader cache for connected-service quota snapshots.
 *
 * The same account rendered in multiple mounted blocks must NOT duplicate
 * fetches, so the per-account loader is centralized here and keyed by the full
 * scope (credential scope + serviceId + profileId). Every `isCurrentLoadScope` guard
 * from the original loader is preserved as an `isScopeActive` check so a
 * credential change can never let a stale in-flight request choose the wrong
 * endpoint or commit the wrong snapshot.
 */

export type QuotaSnapshotStoreEntry = Readonly<{
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    loading: boolean;
    error: string | null;
    /** True for the lifetime of a `refreshQuotaSnapshot` (server refresh + poll). */
    refreshing: boolean;
    /** A read has completed (with or without a snapshot): "no snapshot" is then an answer, not a wait. */
    read: boolean;
}>;

export type LegacyQuotaSnapshotLoadContext = Readonly<{
    transport?: 'legacy';
    credentials: AuthCredentials;
    credentialScope: string;
    serverBasis: ExpectedActiveServerFetchBasis;
    serviceId: ConnectedServiceId;
    profileId: string;
    resolveAccountMode: () => Promise<CredentialScopedAccountMode>;
    assertOperationAllowed(
        operation: BuiltInLegacyConnectedAccountOperation,
    ): Promise<void>;
}>;

export type QuotaSnapshotLoadContext = LegacyQuotaSnapshotLoadContext;

export type QuotaRecoveryConsumeContext =
    LegacyQuotaSnapshotLoadContext & Readonly<{
    machineId: string;
    providerCreditId?: string | null;
}>;

export type QuotaRecoveryConsumeResult =
    | Readonly<{ ok: true; receipt: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>
    | Readonly<{ ok: false; error: string; receipt?: ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1 }>;

type InternalEntry = {
    snapshot: ConnectedServiceQuotaSnapshotV1 | null;
    loading: boolean;
    error: string | null;
    refreshing: boolean;
    /** Credential scope this entry was last retained for; drives eviction. */
    credentialScope: string | null;
    loadAttempted: boolean;
    nextFetchAtMs: number;
    consecutiveErrors: number;
    loadPromise: Promise<ConnectedServiceQuotaSnapshotV1 | null> | null;
    refreshPromise: Promise<void> | null;
    pollRetainCount: number;
    observation: ReturnType<typeof observeUsageProjection> | null;
    pollContext: QuotaSnapshotLoadContext | null;
    /** Public, immutable projection handed to subscribers (stable when unchanged). */
    view: QuotaSnapshotStoreEntry;
};

const REFRESH_RELOAD_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 3_000, 4_000] as const;

const EMPTY_VIEW: QuotaSnapshotStoreEntry = { snapshot: null, loading: false, error: null, refreshing: false, read: false };

const entries = new Map<string, InternalEntry>();
const listenersByKey = new Map<string, Set<() => void>>();

const activeCredentialScopeRetainCounts = new Map<string, number>();

export function buildQuotaSnapshotScopeKey(
    credentialScope: string,
    serviceId: ConnectedServiceId,
    profileId: string,
): string {
    return [credentialScope, connectedServiceProfileKey({ serviceId, profileId })].join(' ');
}

function getOrCreateEntry(key: string): InternalEntry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: InternalEntry = {
        snapshot: null,
        loading: false,
        error: null,
        refreshing: false,
        credentialScope: null,
        loadAttempted: false,
        nextFetchAtMs: 0,
        consecutiveErrors: 0,
        loadPromise: null,
        refreshPromise: null,
        pollRetainCount: 0,
        observation: null,
        pollContext: null,
        view: EMPTY_VIEW,
    };
    entries.set(key, created);
    return created;
}

function notify(key: string): void {
    const listeners = listenersByKey.get(key);
    if (!listeners) return;
    for (const listener of listeners) listener();
}

function publish(key: string, entry: InternalEntry): void {
    entry.view = {
        snapshot: entry.snapshot,
        loading: entry.loading,
        error: entry.error,
        refreshing: entry.refreshing,
        read: entry.loadAttempted && !entry.loading,
    };
    notify(key);
}

function isScopeActive(credentialScope: string): boolean {
    return (activeCredentialScopeRetainCounts.get(credentialScope) ?? 0) > 0;
}

function retainCredentialScope(credentialScope: string): () => void {
    activeCredentialScopeRetainCounts.set(
        credentialScope,
        (activeCredentialScopeRetainCounts.get(credentialScope) ?? 0) + 1,
    );
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const next =
            (activeCredentialScopeRetainCounts.get(credentialScope) ?? 0) - 1;
        if (next > 0) {
            activeCredentialScopeRetainCounts.set(credentialScope, next);
        } else {
            activeCredentialScopeRetainCounts.delete(credentialScope);
        }
    };
}

function sleep(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drops cached entries that belong to a superseded credential scope.
 *
 * A retained entry is what preserves last-known-good across an unmount, so an
 * entry is never dropped while its scope is the one in use. Once a re-login,
 * server switch, or generation bump makes a different scope active, the old
 * scope's keys can never be read again, so its unretained entries are released
 * instead of being stranded for the session lifetime.
 */
function evictEntriesOutsideCredentialScope(activeCredentialScope: string): void {
    for (const [key, entry] of entries) {
        if (entry.pollRetainCount > 0) continue;
        if (entry.credentialScope === activeCredentialScope) continue;
        entry.observation?.dispose();
        entries.delete(key);
    }
}

export function getQuotaSnapshotEntry(key: string | null): QuotaSnapshotStoreEntry {
    if (!key) return EMPTY_VIEW;
    return entries.get(key)?.view ?? EMPTY_VIEW;
}

export function subscribeQuotaSnapshotEntry(key: string | null, listener: () => void): () => void {
    if (!key) return () => {};
    let listeners = listenersByKey.get(key);
    if (!listeners) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
        listeners?.delete(listener);
        if (listeners && listeners.size === 0) listenersByKey.delete(key);
    };
}

async function runLoad(key: string, ctx: QuotaSnapshotLoadContext): Promise<ConnectedServiceQuotaSnapshotV1 | null> {
    const entry = getOrCreateEntry(key);
    if (entry.loadPromise) return entry.loadPromise;

    const promise = (async (): Promise<ConnectedServiceQuotaSnapshotV1 | null> => {
        if (!isScopeActive(ctx.credentialScope)) return null;
        entry.loading = true;
        entry.error = null;
        publish(key, entry);
        try {
            const mode = await ctx.resolveAccountMode();
            if (!isScopeActive(ctx.credentialScope)) return null;
            // A read is the server's GET: the server decides the route and storage mode (404/409),
            // so no machine is asked. Daemon-executed operations (refresh, recovery) stay admitted.

            if (mode === 'plain') {
                const opened = await getConnectedServiceQuotaSnapshotPlain(ctx.credentials, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                }, {
                    expectedActiveServer: ctx.serverBasis,
                });
                if (!isScopeActive(ctx.credentialScope)) return null;
                entry.snapshot = opened;
                entry.consecutiveErrors = 0;
                entry.nextFetchAtMs = getUsageProjectionNextReadAtMs({ consecutiveErrors: 0,
                    legacyStaleAfterMs: opened?.staleAfterMs ?? 30_000 });
                return opened;
            }

            const sealed = await getConnectedServiceQuotaSnapshotSealed(ctx.credentials, {
                serviceId: ctx.serviceId,
                profileId: ctx.profileId,
            }, {
                expectedActiveServer: ctx.serverBasis,
            });
            const opened = sealed
                ? openConnectedServiceQuotaViewSnapshot(ctx.credentials, sealed.sealed, {
                    serviceId: ctx.serviceId,
                    profileId: ctx.profileId,
                })
                : null;
            if (!isScopeActive(ctx.credentialScope)) return null;
            entry.snapshot = opened;
            entry.consecutiveErrors = 0;
            entry.nextFetchAtMs = getUsageProjectionNextReadAtMs({ consecutiveErrors: 0,
                legacyStaleAfterMs: opened?.staleAfterMs ?? 30_000 });
            return opened;
        } catch (error) {
            if (!isScopeActive(ctx.credentialScope)) return null;
            entry.error = sanitizeEndpointErrorMessage(error) ?? t('common.error');
            entry.consecutiveErrors += 1;
            entry.nextFetchAtMs = getUsageProjectionNextReadAtMs({ consecutiveErrors: entry.consecutiveErrors });
            if (!entry.snapshot) entry.snapshot = null;
            return null;
        } finally {
            if (isScopeActive(ctx.credentialScope)) {
                entry.loading = false;
            }
            entry.loadPromise = null;
            publish(key, entry);
            entry.observation?.reconcile();
        }
    })();

    entry.loadPromise = promise;
    return promise;
}

/**
 * Read an account's snapshot once per launch (if nothing was read yet) without polling; the credential
 * scope stays live while the caller is mounted so the answer lands.
 */
export function retainQuotaSnapshotOnce(key: string, ctx: QuotaSnapshotLoadContext): () => void {
    const releaseCredentialScope = retainCredentialScope(ctx.credentialScope);
    const entry = getOrCreateEntry(key);
    entry.credentialScope = ctx.credentialScope;
    evictEntriesOutsideCredentialScope(ctx.credentialScope);
    if (!entry.loadAttempted) {
        entry.loadAttempted = true;
        void runLoad(key, ctx);
    }
    return releaseCredentialScope;
}

export function retainQuotaSnapshotPolling(key: string, ctx: QuotaSnapshotLoadContext): () => void {
    const releaseCredentialScope = retainCredentialScope(ctx.credentialScope);
    const entry = getOrCreateEntry(key);
    entry.pollRetainCount += 1;
    entry.pollContext = ctx;
    entry.credentialScope = ctx.credentialScope;
    evictEntriesOutsideCredentialScope(ctx.credentialScope);

    if (!entry.observation) entry.observation = observeUsageProjection({
        serverId: ctx.serverBasis.serverId,
        read: () => { entry.loadAttempted = true; return runLoad(key, ctx); },
        busy: () => Boolean(entry.loadPromise || entry.refreshPromise),
        nextReadAtMs: () => entry.nextFetchAtMs,
    });

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCredentialScope();
        const current = entries.get(key);
        if (current !== entry) return;
        current.pollRetainCount = Math.max(0, current.pollRetainCount - 1);
        if (current.pollRetainCount === 0) {
            current.pollContext = null;
            current.observation?.dispose();
            current.observation = null;
        }
    };
}

export async function refreshQuotaSnapshot(key: string, ctx: QuotaSnapshotLoadContext): Promise<void> {
    const entry = getOrCreateEntry(key);
    if (entry.refreshPromise) {
        await entry.refreshPromise;
        return;
    }

    if (!isScopeActive(ctx.credentialScope)) return;
    entry.refreshing = true;
    publish(key, entry);
    const promise = (async () => {
        const inFlightFetchedAt = (await entry.loadPromise
            ?.then((snapshot) => snapshot?.fetchedAt ?? 0)
            .catch(() => 0)) ?? 0;
        if (!isScopeActive(ctx.credentialScope)) return;
        const sinceFetchedAt = Math.max(entry.snapshot?.fetchedAt ?? 0, inFlightFetchedAt);
        try {
            const mode = await ctx.resolveAccountMode();
            if (!isScopeActive(ctx.credentialScope)) return;
            try {
                await ctx.assertOperationAllowed('quota_refresh');
            } catch (error) {
                if (isScopeActive(ctx.credentialScope)) {
                    entry.error =
                        sanitizeEndpointErrorMessage(error)
                        ?? t('common.error');
                    publish(key, entry);
                }
                return;
            }
            if (!isScopeActive(ctx.credentialScope)) return;
            await (mode === 'plain'
                ? requestConnectedServiceQuotaSnapshotRefreshV3(
                    ctx.credentials,
                    {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    },
                    { expectedActiveServer: ctx.serverBasis },
                )
                : requestConnectedServiceQuotaSnapshotRefresh(
                    ctx.credentials,
                    {
                        serviceId: ctx.serviceId,
                        profileId: ctx.profileId,
                    },
                    { expectedActiveServer: ctx.serverBasis },
                ));
        } catch {
            // Best-effort only.
        }
        for (const delayMs of REFRESH_RELOAD_DELAYS_MS) {
            await sleep(delayMs);
            if (!isScopeActive(ctx.credentialScope)) break;
            const opened = await runLoad(key, ctx);
            if (opened && opened.fetchedAt > sinceFetchedAt) break;
        }
    })();

    entry.refreshPromise = promise;
    try {
        await promise;
    } finally {
        if (entry.refreshPromise === promise) entry.refreshPromise = null;
        entry.refreshing = false;
        publish(key, entry);
        entry.observation?.reconcile();
    }
}

export async function consumeQuotaRecoveryCredit(
    key: string,
    ctx: QuotaRecoveryConsumeContext,
): Promise<QuotaRecoveryConsumeResult> {
    const entry = getOrCreateEntry(key);
    try {
        await ctx.assertOperationAllowed('recovery_credit_consume');
        if (!isScopeActive(ctx.credentialScope)) {
            return {
                ok: false,
                error: t('common.error'),
            };
        }
        const result = await connectedServiceQuotaRecoveryCreditConsume({
            machineId: ctx.machineId,
            serverId: ctx.serverBasis.serverId,
            expectedActiveServer: ctx.serverBasis,
            serviceId: ctx.serviceId,
            profileId: ctx.profileId,
            sourceSnapshotFetchedAtMs: entry.snapshot?.fetchedAt ?? null,
            ...(ctx.providerCreditId ? { providerCreditId: ctx.providerCreditId } : {}),
        });
        if (result.ok) {
            entry.snapshot = result.snapshot;
            entry.error = null;
            publish(key, entry);
            return { ok: true, receipt: result.receipt };
        }
        return {
            ok: false,
            error: result.error || result.errorCode,
            ...(result.receipt ? { receipt: result.receipt } : {}),
        };
    } catch (error) {
        return { ok: false, error: sanitizeEndpointErrorMessage(error) ?? t('common.error') };
    }
}

/** Test-only: clear the module-level cache and active credential-scope leases. */
export function __resetConnectedServiceQuotaSnapshotStore(): void {
    for (const entry of entries.values()) {
        entry.observation?.dispose();
    }
    entries.clear();
    listenersByKey.clear();
    activeCredentialScopeRetainCounts.clear();
}
