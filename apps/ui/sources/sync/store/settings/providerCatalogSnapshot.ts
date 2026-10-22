import type { ProviderConnectionsCatalogSnapshotV1, ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { DaemonProviderModelProjectionResponseV1, DaemonProviderModelsResponseV1, DaemonProviderConnectionsDescribeResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange, type HomeCredentialMutationEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { parseToken } from '@/utils/auth/parseToken';
import { canPublishCatalogReceipt, retainCatalogRevision } from './wholeCatalogReceiptOrdering';

/** Public key evidence from a read admitted under persisted E2EE mode; never retained key bytes. */
export type ProviderCatalogCryptoAdmission = Readonly<{ contentPublicKeyFingerprint: string }>;

export type ProviderCatalogSnapshot = Readonly<{
    scope: ServerAccountScope; status: ProviderConnectionsCatalogSnapshotV1['status'];
    catalog: ProviderConnectionsCatalogSnapshotV1; data: ProviderConnectionsCatalogV1 | null;
    revision: number | 'absent'; stale: boolean;
    cryptoAdmission: ProviderCatalogCryptoAdmission | null;
}>;
const snapshots = new Map<string, ProviderCatalogSnapshot>();
type ModelProjection = Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }>;
type ConnectionModels = Extract<DaemonProviderModelsResponseV1, { status: 'success' }>;
type ConnectionCheck = Extract<DaemonProviderConnectionsDescribeResponseV1, { status: 'success' }>;
type ModelDisplay = Readonly<{ kind: 'projection'; value: ModelProjection }>
    | Readonly<{ kind: 'connection-list'; value: ConnectionModels }>
    | Readonly<{ kind: 'connection-check'; value: ConnectionCheck }>;
type ModelProjectionSnapshot = {
    scope: ServerAccountScope;
    data: ModelDisplay | null;
    requested: number;
    accepted: number;
    listeners: Set<() => void>;
};
// One display snapshot per exact credential/query, retired by the same credential
// lifecycle as the Account catalog. Retention creates no read or polling demand.
const modelProjections = new Map<string, ModelProjectionSnapshot>();
const listeners = new Set<() => void>();
let unsubscribeCredentials: (() => void) | null = null;

function onCredentialChange(event: HomeCredentialMutationEvent): void {
    for (const [key, snapshot] of modelProjections) {
        if (!areServerProfileIdentifiersEquivalent(snapshot.scope.serverId, event.serverId)) continue;
        withdrawModelProjection(key, snapshot);
    }
    for (const snapshot of [...snapshots.values()]) {
        if (!snapshot.data || !snapshot.cryptoAdmission
            || !areServerProfileIdentifiersEquivalent(snapshot.scope.serverId, event.serverId)) continue;
        let reason: 'unauthorized' | 'encryption-material-unavailable' | null = null;
        if (event.kind === 'credentials_removed' || !event.credentials) reason = 'unauthorized';
        else {
            try {
                if (parseToken(event.credentials.token) !== snapshot.scope.accountId) reason = 'unauthorized';
            } catch { reason = 'unauthorized'; }
            if (!reason) {
                try {
                    const material = resolveAccountScopedCryptoMaterialFromCredentials(event.credentials);
                    const admitted = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material });
                    if (admitted.contentPublicKeyFingerprint !== snapshot.cryptoAdmission.contentPublicKeyFingerprint) {
                        reason = 'encryption-material-unavailable';
                    }
                } catch { reason = 'encryption-material-unavailable'; }
            }
        }
        if (reason) applyProviderCatalogSnapshot(snapshot.scope, { status: 'unavailable', reason }, true);
    }
    syncCredentialSubscription();
}

function syncCredentialSubscription(): void {
    // Private display data can outlive its last mounted observer. Its admission ends
    // synchronously with the incumbent credential write, not a later render or GET.
    const retainsPrivateData = modelProjections.size > 0 || [...snapshots.values()].some(snapshot => snapshot.data && snapshot.cryptoAdmission);
    if (retainsPrivateData && !unsubscribeCredentials) unsubscribeCredentials = subscribeHomeCredentialChange(onCredentialChange);
    if (!retainsPrivateData && unsubscribeCredentials) {
        unsubscribeCredentials();
        unsubscribeCredentials = null;
    }
}
export function subscribeProviderCatalogSnapshots(listener: () => void): () => void {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getProviderCatalogSnapshot(scope: ServerAccountScope | null | undefined): ProviderCatalogSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}
function modelProjectionKey(scope: ServerAccountScope, credentialKey: string, queryKey: string): string {
    return JSON.stringify([serverAccountScopeKeySuffix(scope), credentialKey, queryKey]);
}
export function getProviderModelProjectionSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): ModelProjection | null {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'projection' ? data.value : null;
}
export function getProviderConnectionModelsSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): ConnectionModels | null {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'connection-list' ? data.value : null;
}
export function providerConnectionCheckQueryKey(machineId: string, connectionId?: string): string {
    return JSON.stringify(['connection-check', machineId, connectionId ?? null]);
}
export function getProviderConnectionCheckSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string): ConnectionCheck | null {
    const data = modelProjections.get(modelProjectionKey(scope, credentialKey, queryKey))?.data;
    return data?.kind === 'connection-check' ? data.value : null;
}
function ensureModelProjectionSnapshot(scope: ServerAccountScope, key: string): ModelProjectionSnapshot {
    let snapshot = modelProjections.get(key);
    if (!snapshot) {
        snapshot = { scope, data: null, requested: 0, accepted: 0, listeners: new Set() };
        modelProjections.set(key, snapshot);
        syncCredentialSubscription();
    }
    return snapshot;
}
function withdrawModelProjection(key: string, snapshot: ModelProjectionSnapshot): void {
    const changed = snapshot.data !== null;
    snapshot.data = null;
    snapshot.accepted = ++snapshot.requested;
    if (snapshot.listeners.size === 0) modelProjections.delete(key);
    if (changed) for (const listener of [...snapshot.listeners]) listener();
}
export function subscribeProviderModelProjectionSnapshot(scope: ServerAccountScope, credentialKey: string, queryKey: string, listener: () => void): () => void {
    const key = modelProjectionKey(scope, credentialKey, queryKey);
    const snapshot = ensureModelProjectionSnapshot(scope, key);
    snapshot.listeners.add(listener);
    return () => {
        snapshot.listeners.delete(listener);
        if (snapshot.listeners.size === 0 && snapshot.data === null && snapshot.accepted >= snapshot.requested
            && modelProjections.get(key) === snapshot) {
            modelProjections.delete(key);
            syncCredentialSubscription();
        }
    };
}
/** Each caller revalidates through its own Action; only admitted successes enter the shared display snapshot. */
export function beginProviderModelProjectionRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ModelProjection) => void {
    const publish = beginModelDisplayRead(scope, credentialKey, queryKey);
    return value => publish({ kind: 'projection', value });
}
export function beginProviderConnectionModelsRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ConnectionModels) => void {
    const publish = beginModelDisplayRead(scope, credentialKey, queryKey);
    return value => publish({ kind: 'connection-list', value });
}
export function beginProviderConnectionCheckRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ConnectionCheck) => void {
    const publish = beginModelDisplayRead(scope, credentialKey, queryKey);
    return value => publish({ kind: 'connection-check', value });
}
function beginModelDisplayRead(scope: ServerAccountScope, credentialKey: string, queryKey: string): (data: ModelDisplay) => void {
    const key = modelProjectionKey(scope, credentialKey, queryKey);
    const target = ensureModelProjectionSnapshot(scope, key);
    const request = ++target.requested;
    return data => {
        // A later successful revalidation wins over an older delayed reply.
        // Cancellation/failure of a newer borrower does not discard a still-valid answer.
        if (modelProjections.get(key) !== target || request < target.accepted) return;
        target.accepted = request;
        if (target.data && sameStrictJsonValue(target.data, data)) return;
        target.data = data;
        for (const listener of [...target.listeners]) listener();
    };
}
export function applyAcknowledgedProviderCatalog(scope: ServerAccountScope, data: ProviderConnectionsCatalogV1, revision: number,
    current: boolean, cryptoAdmission: ProviderCatalogCryptoAdmission | null): void {
    const previous = getProviderCatalogSnapshot(scope);
    if (!canPublishCatalogReceipt({ current, revision, retainedRevision: previous?.revision })) return;
    const next: ProviderCatalogSnapshot = { scope, status: 'loading', catalog: { status: 'loading' },
        data, revision, stale: true, cryptoAdmission };
    if (previous && sameStrictJsonValue(previous, next)) return;
    snapshots.set(serverAccountScopeKeySuffix(scope), next);
    syncCredentialSubscription();
    for (const listener of [...listeners]) listener();
}
export function applyProviderCatalogSnapshot(scope: ServerAccountScope, catalog: ProviderConnectionsCatalogSnapshotV1, current: boolean,
    cryptoAdmission: ProviderCatalogCryptoAdmission | null = null): void {
    if (!current || (catalog.status === 'unavailable' && catalog.reason === 'scope-retired')) return;
    const key = serverAccountScopeKeySuffix(scope);
    const old = snapshots.get(key);
    const withdraw = catalog.status === 'unavailable' && ['account-mode-mismatch', 'encryption-material-unavailable',
        'unauthorized', 'forbidden', 'unsupported', 'account-not-found', 'account-inconsistent', 'invalid-stored-content'].includes(catalog.reason);
    if (withdraw) {
        for (const [modelKey, projection] of modelProjections) {
            if (serverAccountScopeKeySuffix(projection.scope) === key) withdrawModelProjection(modelKey, projection);
        }
        syncCredentialSubscription();
    }
    const candidate = catalog.status === 'ready' || catalog.status === 'partial' ? catalog.catalog : withdraw ? null : old?.data ?? null;
    const data = old?.data && JSON.stringify(old.data) === JSON.stringify(candidate) ? old.data : candidate;
    const next: ProviderCatalogSnapshot = { scope: old?.scope ?? scope, catalog, status: catalog.status, data,
        revision: retainCatalogRevision(catalog, old?.revision),
        stale: catalog.status !== 'ready',
        cryptoAdmission: !data ? null : catalog.status === 'ready' || catalog.status === 'partial'
            ? cryptoAdmission : old?.cryptoAdmission ?? null };
    if (old && JSON.stringify(old) === JSON.stringify(next)) return;
    snapshots.set(key, next);
    syncCredentialSubscription();
    for (const listener of [...listeners]) listener();
}
export function beginProviderCatalogLoad(scope: ServerAccountScope): void {
    applyProviderCatalogSnapshot(scope, { status: 'loading' }, true);
}
export function invalidateProviderCatalogsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) if (snapshot.scope.serverId === serverId) beginProviderCatalogLoad(snapshot.scope);
}
export function resetProviderCatalogSnapshotsForTests(): void {
    snapshots.clear(); modelProjections.clear(); listeners.clear(); syncCredentialSubscription();
}
