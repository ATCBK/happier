import { AccountEncryptionCurrentnessResponseSchema, type AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createManagedConnectionSupervisor, DEFAULT_MANAGED_CONNECTION_POLICY, type ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { fetchAccountEncryptionCurrentness, AccountEncryptionCurrentnessUnavailableError } from '@/api/client/connectedServiceCredentialApi';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';

type Scope = Readonly<{ accountId: string; token: string; serverBaseUrl: string; signal?: AbortSignal }>;
type Observation = Readonly<{
    read(signal?: AbortSignal): Promise<AccountEncryptionCurrentnessResponse>;
    isCurrent(expected: AccountEncryptionCurrentnessResponse): boolean;
    dispose(): Promise<void>;
}>;
type SharedObservation = Observation & { references: number };

// Only admitted requester lifetimes populate this map. It stores an encryption
// fact, never credentials selected by Account id or invocation authorization.
const observations = new Map<string, SharedObservation>();
const scopeKey = (scope: Scope) => JSON.stringify([normalizeServerHttpBaseUrl(scope.serverBaseUrl), scope.accountId]);

export function sameRequesterAccountEncryptionCurrentness(a: AccountEncryptionCurrentnessResponse, b: AccountEncryptionCurrentnessResponse): boolean {
    // Account seq/settings also change for unrelated activity.
    return a.mode === b.mode && a.updatedAt === b.updatedAt
        && a.signingKeyFingerprint === b.signingKeyFingerprint && a.contentKeyFingerprint === b.contentKeyFingerprint;
}

/** HTTP remains the transport fallback outside a subscribed requester lifetime. */
export async function readRequesterAccountEncryptionCurrentness(scope: Scope): Promise<AccountEncryptionCurrentnessResponse> {
    const observed = observations.get(scopeKey(scope));
    return observed ? await observed.read(scope.signal) : await fetchAccountEncryptionCurrentness(scope);
}

/** A synchronous fence after distinct Machine/Home awaits, without another HTTP read. */
export function isRequesterAccountEncryptionCurrentnessObserved(scope: Scope, expected: AccountEncryptionCurrentnessResponse): boolean {
    return observations.get(scopeKey(scope))?.isCurrent(expected) ?? true;
}

/** One exact Account/Home observation shared by live finite and Session custody. */
export function acquireRequesterAccountEncryptionCurrentness(scope: Scope): Observation {
    const key = scopeKey(scope);
    let shared = observations.get(key);
    if (!shared) {
        shared = createObservation(scope);
        observations.set(key, shared);
    }
    shared.references++;
    const owned = shared;
    let released = false;
    return {
        read: signal => owned.read(signal),
        isCurrent: expected => !released && owned.isCurrent(expected),
        async dispose() {
            if (released) return;
            released = true;
            if (--owned.references !== 0) return;
            observations.delete(key);
            await owned.dispose();
        },
    };
}

function createObservation(scope: Scope): SharedObservation {
    let fact: AccountEncryptionCurrentnessResponse | null = null;
    let lifetime = {};
    let connected = false;
    let disposed = false;
    let unsupported = false;
    let readAttempted = false;
    let pending: Promise<void> | null = null;
    let supervisor: ManagedConnectionSupervisor | undefined;
    const invalidate = () => { lifetime = {}; fact = null; readAttempted = false; };
    const refresh = () => {
        if (!connected || disposed || readAttempted) return;
        readAttempted = true;
        const captured = lifetime;
        pending = fetchAccountEncryptionCurrentness({ token: scope.token, serverBaseUrl: scope.serverBaseUrl })
            .then(next => { if (connected && !disposed && lifetime === captured) fact = next; })
            .catch(() => { /* Unknown currentness refuses; transport reconnect owns recovery. */ })
            .finally(() => { if (lifetime === captured) pending = null; });
    };
    // The existing socket/managed-connection owners supply reconnection policy;
    // this observer adds no timer, freshness TTL or retry budget.
    const initial = (async () => {
        const { createUserScopedSocketConnection } = await import('@/api/session/sockets');
        const createTransport = () => {
            const { socket, transport } = createUserScopedSocketConnection({ token: scope.token, serverUrl: scope.serverBaseUrl,
                authorityCeiling: 'account_automation' });
            socket.on('update', (raw: unknown) => {
                if (!connected || disposed || !transport.isConnected()) return;
                const parsed = UpdateContainerSchema.safeParse(raw);
                if (!parsed.success || parsed.data.body.t !== 'update-account' || parsed.data.body.id !== scope.accountId) return;
                if (!('encryptionCurrentness' in parsed.data.body)) return;
                const next = AccountEncryptionCurrentnessResponseSchema.safeParse(parsed.data.body.encryptionCurrentness);
                if (next.success && fact && next.data.version < fact.version) return;
                // A push wins over a concurrently outstanding initial HTTP read.
                invalidate();
                readAttempted = true;
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
        try { first = createTransport(); } catch { unsupported = true; return; }
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
            await initial;
            if (disposed) throw new AccountEncryptionCurrentnessUnavailableError();
            if (unsupported) return await fetchAccountEncryptionCurrentness({ token: scope.token, serverBaseUrl: scope.serverBaseUrl,
                ...(signal ? { signal } : {}) });
            if (connected && !fact) refresh();
            if (pending) await pending;
            signal?.throwIfAborted();
            if (!connected || disposed || !fact) throw new AccountEncryptionCurrentnessUnavailableError();
            return fact;
        },
        async dispose() {
            disposed = true; connected = false; invalidate();
            await initial;
            await supervisor?.stop();
        },
    };
}
