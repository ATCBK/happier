import { $ZodError } from 'zod/v4/core';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { randomUUID } from 'node:crypto';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { beginActiveProviderConnectionsCatalogRefresh, commitActiveProviderConnectionsCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation, observeProviderCatalogPhase } from './catalogStore';
export { readActiveProviderConnectionsCatalog } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const pending = new Map<string, {
  completion: Promise<ProviderConnectionsCatalogSnapshotV1>; readers: Set<() => void>; readable: boolean;
}>();
const reloadAfterPending = new Set<string>();
type RefreshInput = Readonly<{ credentials: StoredCredentials; signal?: AbortSignal; operationContext?: SavedSecretOperationContextV1;
  isCredentialCurrent?(): boolean | Promise<boolean> }>;

type CliCatalogInput = Readonly<{
  expectedScopeKey: string; operationContext?: SavedSecretOperationContextV1; signal?: AbortSignal;
}>;

/** Retained runtime admission demand-loads its captured catalog once. */
export function prepareProviderConnectionsCatalogForCli(input: CliCatalogInput): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return readProviderConnectionsCatalogForCli(input, false);
}

/** Explicit machine operations reobserve row authority before capturing their basis. */
export function refreshProviderConnectionsCatalogForCli(input: CliCatalogInput): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return readProviderConnectionsCatalogForCli(input, true);
}

async function readProviderConnectionsCatalogForCli(input: CliCatalogInput, reobserve: boolean): Promise<ProviderConnectionsCatalogSnapshotV1> {
  const snapshot = input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  if (snapshot?.scopeKey !== input.expectedScopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  const operationContext = input.operationContext;
  if (operationContext && !await observeProviderCatalogPhase({ catalogReadId: randomUUID(), phase: 'admission_currentness' },
    () => operationContext.isCurrent())) return { status: 'unavailable', reason: 'scope-retired' };
  if (!reobserve && snapshot.providerConnectionsCatalog?.status === 'ready') return snapshot.providerConnectionsCatalog;
  const credentials = input.operationContext?.credentials ?? await readStoredCredentials();
  if (!credentials || resolveAccountSettingsScopeKey(credentials) !== input.expectedScopeKey) return { status: 'unavailable', reason: 'scope-retired' };
  if (!input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) return { status: 'unavailable', reason: 'scope-retired' };
  const refreshInput = { credentials, operationContext: input.operationContext, signal: input.signal };
  const readSnapshot = () => input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  let resolveReadable!: (catalog: ProviderConnectionsCatalogSnapshotV1) => void;
  const readable = new Promise<ProviderConnectionsCatalogSnapshotV1>(resolve => { resolveReadable = resolve; });
  const observeReadable = () => {
    const catalog = readSnapshot()?.providerConnectionsCatalog;
    if (catalog?.status === 'ready') resolveReadable(catalog);
  };
  // Readiness belongs to the refresh, including an equal-row publication
  // which intentionally produces no broad Account notification.
  const completion = refresh(refreshInput, reobserve ? 'reobserve' : 'read', observeReadable);
  // Source preference handoff still precedes this publication; optional
  // history maintenance remains with the loader without holding admission.
  const result = await Promise.race([completion, readable]);
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (input.operationContext && !await input.operationContext.isCurrent()) return { status: 'unavailable', reason: 'scope-retired' };
  const admitted = readSnapshot();
  if (input.signal?.aborted) return { status: 'unavailable', reason: 'cancelled' };
  if (admitted?.scopeKey !== input.expectedScopeKey
    || !input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetimeToken) {
    return { status: 'unavailable', reason: 'scope-retired' };
  }
  if (result.status !== 'ready') return result;
  return admitted.providerConnectionsCatalog ?? { status: 'unavailable', reason: 'unreachable' };
}

/** Demand-load the sole catalog in the caller's existing Account custody. */
export function refreshActiveProviderConnectionsCatalog(input: RefreshInput,
  options?: Readonly<{ afterChange?: boolean }>): Promise<ProviderConnectionsCatalogSnapshotV1> {
  return refresh(input, options?.afterChange === true ? 'change' : 'read');
}

function refresh(input: RefreshInput, intent: 'read' | 'reobserve' | 'change' = 'read', onReadable?: () => void): Promise<ProviderConnectionsCatalogSnapshotV1> {
  const context = input.operationContext;
  const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
  const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const key = `${scopeKey}:${lifetimeToken}`;
  const readSnapshot = () => context ? context.readSnapshot() : getActiveAccountSettingsSnapshot();
  const current = () => readSnapshot()?.scopeKey === scopeKey
    && (context ? context.credentials.token === input.credentials.token : getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken);
  if (!current() || input.signal?.aborted) return Promise.resolve({ status: 'unavailable', reason: 'scope-retired' });
  const existing = context ? undefined : pending.get(key);
  if (existing) {
    // Readers arriving before the row is published share that observation.
    // A later explicit read must reobserve authority, even while the previous
    // read's optional cleanup continues; actual changes always invalidate it.
    if (intent === 'change' || intent === 'reobserve' && existing.readable) {
      existing.readable = false;
      reloadAfterPending.add(key); beginActiveProviderConnectionsCatalogRefresh({ scopeKey, lifetimeToken });
    }
    if (onReadable) {
      if (existing.readable) onReadable();
      else existing.readers.add(onReadable);
    }
    return existing.completion;
  }
  if (!context) beginActiveProviderConnectionsCatalogRefresh({ scopeKey, lifetimeToken });
  const store = context ? createCliProviderConnectionsStoreForOperation({ operationContext: context, signal: input.signal })
    : createCliProviderConnectionsStore(input);
  const publish = async (catalog: ProviderConnectionsCatalogSnapshotV1) => {
    if (!current() || context && !await context.isCurrent()) return false;
    const expectedSettingsVersion = readSnapshot()?.settingsVersion;
    return context ? expectedSettingsVersion !== undefined
      && await context.commitProviderConnectionsCatalog({ expectedSettingsVersion, catalog })
      : commitActiveProviderConnectionsCatalog({ scopeKey, lifetimeToken, catalog });
  };
  let work!: Promise<ProviderConnectionsCatalogSnapshotV1>;
  work = (async (): Promise<ProviderConnectionsCatalogSnapshotV1> => {
    while (true) {
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (!context) reloadAfterPending.delete(key);
      const request = context ? undefined : pending.get(key);
      if (request) request.readable = false;
      let catalog: ProviderConnectionsCatalogSnapshotV1;
      let publishedReady: ProviderConnectionsCatalogSnapshotV1 | undefined;
      try {
        catalog = await store.readCatalog({ onReadyBeforeCleanup: async ready => {
          if (!context && reloadAfterPending.has(key)) return;
          if (await publish(ready)) {
            if (!context && reloadAfterPending.has(key)) return;
            publishedReady = ready;
            if (context) onReadable?.();
            else {
              const request = pending.get(key);
              if (request) {
                request.readable = true;
                const readers = [...request.readers];
                request.readers.clear();
                for (const reader of readers) reader();
              }
            }
          }
        }, hasPendingCleanup: () => !context && reloadAfterPending.has(key) });
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        catalog = { status: 'unavailable', reason: input.signal?.aborted ? 'cancelled'
          : !current() || code === 'scope-retired' ? 'scope-retired'
          : code === 'unauthorized' || code === 'forbidden' || code === 'unsupported' || code === 'account-mode-mismatch' ? code
          : code === 'account_storage_currentness_unavailable' || code === 'account_encryption_currentness_unavailable' ? 'encryption-material-unavailable'
          : error instanceof $ZodError ? 'invalid-stored-content' : 'unreachable' };
      }
      if (!current()) return { status: 'unavailable', reason: 'scope-retired' };
      if (!context && reloadAfterPending.has(key)) continue;
      if (!context && pending.get(key)?.completion === work) pending.delete(key);
      // Cancelling optional maintenance cannot withdraw a row already admitted
      // to this still-current Account. No new authority is published here.
      if (publishedReady && catalog.status === 'unavailable' && catalog.reason === 'cancelled') return publishedReady;
      if (!await publish(catalog)) return { status: 'unavailable', reason: 'scope-retired' };
      return catalog;
    }
  })().finally(() => {
    if (pending.get(key)?.completion === work) { pending.delete(key); reloadAfterPending.delete(key); }
  });
  if (!context) pending.set(key, { completion: work, readers: new Set(onReadable ? [onReadable] : []), readable: false });
  return work;
}

/** The incumbent Account-change observer reopens only an already-demanded catalog. */
export async function refreshDemandedActiveProviderConnectionsCatalog(input: Readonly<{ token: string; signal?: AbortSignal }>): Promise<void> {
  if (getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog === undefined) return;
  const credentials = await readStoredCredentials();
  if (!credentials || credentials.token !== input.token) return;
  await refresh({ credentials, signal: input.signal }, 'change');
}
