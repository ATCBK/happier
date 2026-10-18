import { AccountEncryptionCurrentnessResponseSchema, type AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY, type ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { fetchAccountEncryptionCurrentnessFromServer, AccountEncryptionCurrentnessUnavailableError } from '@/api/client/connectedServiceCredentialApi';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { logger } from '@/ui/logger';

type Scope = Readonly<{ accountId: string; token: string; serverBaseUrl: string; signal?: AbortSignal }>;
type Observation = Readonly<{
    read(signal?: AbortSignal): Promise<AccountEncryptionCurrentnessResponse>;
    isCurrent(expected: AccountEncryptionCurrentnessResponse): boolean;
    dispose(): Promise<void>;
}>;
type SharedObservation = Observation & { references: number };

// Only lifetimes with an authenticated Account/Home populate this map.
// It stores a fact, never credentials selected by Account id or invocation authorization.
const observations = new Map<string, SharedObservation>();
const scopeKey = (scope: Scope) => JSON.stringify([normalizeServerHttpBaseUrl(scope.serverBaseUrl), scope.accountId]);

/** Borrow a fact, never authentication or another holder's credentials. No holder means fresh HTTP. */
export function readObservedAccountEncryptionCurrentness(scope: Readonly<{
    token: string; serverBaseUrl: string; signal?: AbortSignal;
}>): Promise<AccountEncryptionCurrentnessResponse> | null {
    const accountId = readAccountIdFromToken(scope.token);
    return accountId ? observations.get(scopeKey({ ...scope, accountId }))?.read(scope.signal) ?? null : null;
}

export function sameRequesterAccountEncryptionCurrentness(a: AccountEncryptionCurrentnessResponse, b: AccountEncryptionCurrentnessResponse): boolean {
    // Account seq/settings also change for unrelated activity.
    return a.mode === b.mode && a.updatedAt === b.updatedAt
        && a.signingKeyFingerprint === b.signingKeyFingerprint && a.contentKeyFingerprint === b.contentKeyFingerprint;
}

/** HTTP remains the transport fallback outside a subscribed requester lifetime. */
export async function readRequesterAccountEncryptionCurrentness(scope: Scope): Promise<AccountEncryptionCurrentnessResponse> {
    const observed = observations.get(scopeKey(scope));
    return observed ? await observed.read(scope.signal) : await fetchAccountEncryptionCurrentnessFromServer(scope);
}

/** A synchronous fence after distinct Machine/Home awaits, without another HTTP read. */
export function isRequesterAccountEncryptionCurrentnessObserved(scope: Scope, expected: AccountEncryptionCurrentnessResponse): boolean {
    return observations.get(scopeKey(scope))?.isCurrent(expected) ?? true;
}

/** One exact Account/Home observation shared by live finite custody holders. */
export function acquireRequesterAccountEncryptionCurrentness(scope: Scope): Observation {
    const key = scopeKey(scope);
    let shared = observations.get(key);
    if (!shared) {
        shared = createObservation(scope);
        observations.set(key, shared);
    }
    shared.references++;
    const owned = shared;
    const retirement = new AbortController();
    let released = false;
    return {
        read: signal => released ? Promise.reject(new AccountEncryptionCurrentnessUnavailableError())
            : owned.read(signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal),
        isCurrent: expected => !released && owned.isCurrent(expected),
        async dispose() {
            if (released) return;
            released = true;
            retirement.abort();
            if (--owned.references !== 0) return;
            observations.delete(key);
            await owned.dispose();
        },
    };
}

function createObservation(scope: Scope): SharedObservation {
    let fact: AccountEncryptionCurrentnessResponse | null = null;
    let lifetime = new AbortController();
    const retirement = new AbortController();
    let connected = false;
    let disposed = false;
    let unsupported = false;
    let pending: Promise<void> | null = null;
    let readError: unknown = null;
    let supervisor: ManagedConnectionSupervisor | undefined;
    const invalidate = () => { lifetime.abort(); lifetime = new AbortController(); fact = null; pending = null; readError = null; };
    const refresh = () => {
        if (!connected || disposed || fact || pending) return;
        const captured = lifetime;
        pending = waitForObservation(fetchAccountEncryptionCurrentnessFromServer({ token: scope.token, serverBaseUrl: scope.serverBaseUrl,
            signal: captured.signal }), captured.signal)
            .then(next => { if (connected && !disposed && lifetime === captured) fact = next; })
            .catch(error => { if (lifetime === captured) readError = error; })
            .finally(() => { if (lifetime === captured) pending = null; });
    };
    // The existing socket/managed-connection owners supply reconnection policy;
    // this observer adds no timer, freshness TTL or retry budget.
    const initial = (async () => {
        const { createUserScopedSocketConnection } = await import('@/api/session/sockets');
        if (disposed) return;
        const createTransport = () => {
            const { socket, transport } = createUserScopedSocketConnection({ token: scope.token, serverUrl: scope.serverBaseUrl,
                authorityCeiling: 'account_automation' });
            socket.on('update', (raw: unknown) => {
                if (!connected || disposed || !transport.isConnected()) return;
                const parsed = UpdateContainerSchema.safeParse(raw);
                if (!parsed.success) {
                    // Invalid matching encryption publication withdraws trust;
                    // its contents are never admitted as an Account fact.
                    const body = raw && typeof raw === 'object' && 'body' in raw ? raw.body : null;
                    if (body && typeof body === 'object' && 't' in body && body.t === 'update-account'
                        && 'id' in body && body.id === scope.accountId && 'encryptionCurrentness' in body) invalidate();
                    return;
                }
                if (parsed.data.body.t !== 'update-account' || parsed.data.body.id !== scope.accountId) return;
                if (!('encryptionCurrentness' in parsed.data.body)) return;
                const next = AccountEncryptionCurrentnessResponseSchema.safeParse(parsed.data.body.encryptionCurrentness);
                if (next.success && fact && next.data.version < fact.version) return;
                // A push wins over a concurrently outstanding initial HTTP read.
                invalidate();
                fact = next.success ? next.data : null;
                pending = null;
            });
            transport.onConnected(() => { connected = true; invalidate(); refresh(); });
            transport.onDisconnected(() => { connected = false; invalidate(); pending = null; });
            return transport;
        };
        // A runtime without this transport keeps the incumbent fresh HTTP path.
        // Once a channel exists, connection failure is unknown, never fallback.
        let first: ReturnType<typeof createTransport>;
        try { first = createTransport(); } catch {
            logger.warn('Account encryption observation transport unavailable; using fresh HTTP reads.');
            unsupported = true;
            return;
        }
        let initialTransport = true;
        supervisor = createManagedConnectionSupervisor({ ...DEFAULT_MANAGED_CONNECTION_POLICY,
            createTransport: () => { if (initialTransport) { initialTransport = false; return first; } return createTransport(); },
            probeReadiness: async () => ({ status: 'ready' }), classifyTransportErrorToProbeResult,
            onAuthFailed: () => { connected = false; invalidate(); },
        });
        if (disposed) { await first.destroy(); return; }
        await supervisor.start();
    })();
    return {
        references: 0,
        isCurrent: expected => !disposed && (unsupported || connected && fact !== null && sameRequesterAccountEncryptionCurrentness(fact, expected)),
        async read(signal) {
            signal?.throwIfAborted();
            const readerSignal = signal ? AbortSignal.any([signal, retirement.signal]) : retirement.signal;
            await waitForObservation(initial, readerSignal);
            if (disposed) throw new AccountEncryptionCurrentnessUnavailableError();
            if (unsupported) return await fetchAccountEncryptionCurrentnessFromServer({ token: scope.token, serverBaseUrl: scope.serverBaseUrl,
                signal: readerSignal });
            if (connected && !fact) refresh();
            if (pending) await waitForObservation(pending, readerSignal);
            signal?.throwIfAborted();
            if (!connected || disposed) throw new AccountEncryptionCurrentnessUnavailableError();
            if (!fact) throw readError ?? new AccountEncryptionCurrentnessUnavailableError();
            return fact;
        },
        async dispose() {
            disposed = true; connected = false; retirement.abort(); invalidate();
            await supervisor?.stop();
            await initial;
        },
    };
}

/** Reader cancellation must not cancel a different holder's shared subscription. */
function waitForObservation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        const detach = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        operation.then(value => { detach(); resolve(value); }, error => { detach(); reject(error); });
        if (signal.aborted) { detach(); abort(); }
    });
}
