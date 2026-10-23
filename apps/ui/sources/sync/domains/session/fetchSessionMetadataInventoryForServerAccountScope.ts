import { isTokenOnlyAuthCredentials, subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { fetchAndApplySessions } from '@/sync/engine/sessions/syncSessions';
import { exhaustSessionListPages } from '@/sync/engine/sessions/exhaustSessionListPages';
import { serverFetch } from '@/sync/http/client';
import {
    captureServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveUiClientEncryptionRequirementForScope } from '@/sync/domains/settings/clientEncryptionRequirement';

export type SessionMetadataInventoryAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

type SessionMetadataInventoryAuthority = ServerAccountRequestAuthority;

async function fetchSessionMetadataInventoryWithAuthority(params: Readonly<{
    scope: ServerAccountScope;
    authority: SessionMetadataInventoryAuthority;
    signal: AbortSignal;
    baseline: Readonly<Record<string, SessionListRenderableSession>>;
}>): Promise<void> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Scoped Session inventory credentials are unavailable');
    if (!areServerAccountScopesEqual(params.authority.scope, params.scope)) {
        throw new Error('Scoped Session inventory authority does not match requested Account');
    }
    const encryption = isTokenOnlyAuthCredentials(credentials)
        ? null
        : await createEncryptionFromAuthCredentials(credentials);
    const sessionDataKeys = new Map<string, Uint8Array>();
    const sessionDataKeyEnvelopes = new Map<string, string>();
    const tuning = loadSyncTuning();
    const shouldContinue = () => !params.signal.aborted;
    const renderablesBySessionId = new Map<string, SessionListRenderableSession>();

    const fetchListing = async (sessionListPath: string | undefined): Promise<void> => {
        let cursor: string | null = null;
        let hasNext = false;
        const fetchPage = async (pageCursor: string | null) => await fetchAndApplySessions({
            clientEncryptionRequirement: resolveUiClientEncryptionRequirementForScope({
                scope: params.scope,
                focusedSettings: storage.getState().settings,
            }),
            ...(sessionListPath
                ? { sessionListPath }
                : pageCursor === null
                    ? { includeActiveSessionRows: true }
                    : {}),
            sessionListCursor: pageCursor,
            sessionListMaxPages: 1,
            serverId: params.scope.serverId,
            credentials,
            encryption,
            sessionDataKeys,
            sessionDataKeyEnvelopes,
            request: (path, init) => params.authority.request(path, { ...init, signal: params.signal }),
            // Collected rows win across pages; the captured baseline supplies
            // prior owner provenance without retaining absent inventory members.
            getCurrentSessionListRenderable: (sessionId) => renderablesBySessionId.get(sessionId) ?? params.baseline[sessionId] ?? null,
            shouldContinue,
            applySessions: () => {},
            applySessionListRenderables: (sessions) => {
                if (!shouldContinue()) return;
                for (const session of sessions) renderablesBySessionId.set(session.id, session);
            },
            sessionListHydrationConcurrencyLimit: tuning.sessionListHydrationConcurrencyLimit,
            log: { log: () => {} },
        });
        await exhaustSessionListPages({
            fetchFirstPage: async () => {
                const result = await fetchPage(null);
                cursor = result.nextCursor;
                hasNext = result.hasNext;
            },
            hasNextPage: () => hasNext && Boolean(cursor),
            fetchNextPage: async () => {
                const result = await fetchPage(cursor);
                cursor = result.nextCursor;
                hasNext = result.hasNext;
            },
            shouldContinue,
        });
    };

    await fetchListing(undefined);
    if (shouldContinue()) await fetchListing('/v2/sessions/archived');
    if (shouldContinue()) {
        storage.getState().reconcileSessionListRowsForServerScope(
            params.scope.serverId,
            [...renderablesBySessionId.values()],
            params.baseline,
        );
    }
}

type SessionMetadataInventoryEnsureEntry = {
    controller: AbortController;
    promise: Promise<void>;
    status: 'pending' | 'ready';
    disposeCredentialWatch: () => void;
};

const inventoryEnsures = new Map<string, SessionMetadataInventoryEnsureEntry>();

function inventoryEnsureKey(scope: ServerAccountScope): string {
    return JSON.stringify([scope.serverId, scope.accountId]);
}

function createAbortError(): Error {
    return new DOMException('Aborted', 'AbortError');
}

async function runSessionMetadataInventory(params: Readonly<{
    scope: ServerAccountScope;
    signal: AbortSignal;
}>): Promise<void> {
    let authority: SessionMetadataInventoryAuthority | null = null;
    const baseline = storage.getState().sessionListRowsByServerId[params.scope.serverId] ?? {};
    try {
        if (params.signal.aborted) throw createAbortError();
        authority = await captureServerRequestAuthorityForServerAccountScope({
            scope: params.scope,
            activeRequest: (path, init) => serverFetch(path, init),
        });
        if (params.signal.aborted) throw createAbortError();
        await fetchSessionMetadataInventoryWithAuthority({
            scope: params.scope,
            authority,
            signal: params.signal,
            baseline,
        });
    } finally {
        await authority?.release();
    }
}

function waitForInventoryEnsure(params: Readonly<{
    entry: SessionMetadataInventoryEnsureEntry;
    accountLifetime: SessionMetadataInventoryAccountLifetime;
    signal?: AbortSignal;
}>): Promise<void> {
    if (params.signal?.aborted || !params.accountLifetime.isCurrent()) {
        return Promise.reject(createAbortError());
    }
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let retirement: Readonly<{ dispose(): void }> | null = null;
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            params.signal?.removeEventListener('abort', retire);
            retirement?.dispose();
            if (error !== undefined) reject(error);
            else resolve();
        };
        const retire = () => finish(createAbortError());
        retirement = params.accountLifetime.onRetire(retire);
        if (settled) retirement.dispose();
        params.signal?.addEventListener('abort', retire, { once: true });
        // Abort may race the initial check and listener registration.
        if (params.signal?.aborted || !params.accountLifetime.isCurrent()) retire();
        params.entry.promise.then(
            () => finish(),
            (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
}

/**
 * Materializes the complete current and archived Session metadata projection for
 * one explicitly selected Home. The exact credential authority—not the active
 * Sync singleton—owns transport and Account identity. A consumer may detach
 * without cancelling shared work; the canonical Home credential mutation
 * aborts that work and fences every store publication.
 */
export async function ensureSessionMetadataInventoryForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    accountLifetime: SessionMetadataInventoryAccountLifetime;
    signal?: AbortSignal;
    /** Explicit retry after a reported failure; ordinary consumers reuse ready/in-flight work. */
    refresh?: boolean;
}>): Promise<void> {
    if (params.signal?.aborted || !params.accountLifetime.isCurrent()) throw createAbortError();
    const key = inventoryEnsureKey(params.scope);
    let entry = inventoryEnsures.get(key);
    if (entry?.controller.signal.aborted) {
        entry.disposeCredentialWatch();
        inventoryEnsures.delete(key);
        entry = undefined;
    }
    const projectionExists = params.scope.serverId in storage.getState().sessionListRowsByServerId;
    if (params.refresh || (entry?.status === 'ready' && !projectionExists)) {
        entry?.controller.abort();
        entry?.disposeCredentialWatch();
        inventoryEnsures.delete(key);
        entry = undefined;
    }
    if (!entry) {
        const controller = new AbortController();
        const created: SessionMetadataInventoryEnsureEntry = {
            controller,
            status: 'pending',
            promise: Promise.resolve(),
            disposeCredentialWatch: () => {},
        };
        created.promise = runSessionMetadataInventory({ scope: params.scope, signal: controller.signal })
            .then(() => {
                if (controller.signal.aborted) throw createAbortError();
                created.status = 'ready';
            })
            .catch((error: unknown) => {
                if (inventoryEnsures.get(key) === created) {
                    inventoryEnsures.delete(key);
                    created.disposeCredentialWatch();
                }
                throw error;
            });
        inventoryEnsures.set(key, created);
        created.disposeCredentialWatch = subscribeHomeCredentialMutations((event) => {
            if (!areServerProfileIdentifiersEquivalent(params.scope.serverId, event.serverId)) return;
            created.controller.abort();
            created.disposeCredentialWatch();
            if (inventoryEnsures.get(key) === created) inventoryEnsures.delete(key);
            storage.getState().clearSessionListRowsForServerScope(params.scope.serverId);
        });
        entry = created;
    }
    await waitForInventoryEnsure({
        entry,
        accountLifetime: params.accountLifetime,
        ...(params.signal ? { signal: params.signal } : {}),
    });
}
