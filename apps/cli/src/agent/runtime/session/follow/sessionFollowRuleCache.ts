import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { openSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

export type SessionFollowRuleCacheSnapshot = Readonly<{ status: 'available'; rules: readonly OpenedSessionFollowRuleV1[]; defaultPreferences?: SessionAutoFollowPreferencesV1 }>
  | Readonly<{ status: 'unavailable'; reason: string }>;
export type SessionFollowRuleInvalidation = Readonly<{ full: boolean }>;

/** The admitted daemon owns this cache for one captured Account lifetime. */
export function createSessionFollowRuleCache(input: Readonly<{
  signal: AbortSignal; isCurrent: () => boolean;
  subscribeInvalidation: (listener: (change?: SessionFollowRuleInvalidation) => void) => () => void;
  read: () => Promise<Readonly<{ mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; rules: readonly SessionFollowRuleV1[]; defaultPreferences?: SessionAutoFollowPreferencesV1 }> | null>;
}>) {
  type Observation = Readonly<{ snapshot: SessionFollowRuleCacheSnapshot; revision: number }>;
  let retired = false;
  let revision = 0;
  let loaded: Observation | null = null;
  let pending: Promise<Observation> | null = null;
  let refreshing: Promise<Observation> | null = null;
  const current = () => !retired && !input.signal.aborted && input.isCurrent();
  const unavailable = (reason: string): Observation => ({ revision, snapshot: { status: 'unavailable', reason } });
  const invalidate = () => { revision++; loaded = null; };
  // Run/Discussion progress wakes consumers without changing rule configuration.
  // Unqualified notifications still withdraw the snapshot, including requester resets.
  const unsubscribe = input.subscribeInvalidation(change => { if (change?.full !== false) invalidate(); });
  const dispose = () => {
    if (retired) return;
    retired = true;
    invalidate();
    unsubscribe();
    input.signal.removeEventListener('abort', dispose);
  };
  input.signal.addEventListener('abort', dispose, { once: true });
  if (input.signal.aborted) dispose();
  const read = async (): Promise<Observation> => {
    if (!current()) return unavailable('account-retired');
    if (loaded) return loaded;
    if (pending) return pending;
    const observedRevision = revision;
    const load = async (): Promise<Observation> => {
      try {
        const source = await input.read();
        if (!current()) return unavailable('account-retired');
        if (revision !== observedRevision || pending !== work) return unavailable('rules-changed');
        if (!source) return unavailable('private-rules-unavailable');
        const rules: OpenedSessionFollowRuleV1[] = [];
        for (const row of source.rules) {
          const opened = openSessionFollowRuleContentV1({ ...row, mode: source.mode, material: source.material });
          if (opened.status !== 'opened') return unavailable(opened.reason);
          rules.push({ ruleId: row.ruleId, version: row.version, receiver: row.receiver, definition: opened.definition,
            ...(row.inception ? { inception: row.inception } : {}),
            ...(row.sources ? { sources: row.sources } : {}) });
        }
        // Unavailable is never memoized as an empty set; another source/change wake may repair it.
        loaded = { revision: observedRevision, snapshot: { status: 'available', rules,
          ...(source.defaultPreferences ? { defaultPreferences: source.defaultPreferences } : {}) } };
        return loaded;
      } catch {
        return unavailable('private-rules-unavailable');
      }
    };
    const work = load();
    pending = work;
    try { return await work; }
    finally { if (pending === work) pending = null; }
  };
  const refresh = async (): Promise<Observation> => {
    // Source notifications and receiver catch-up share this Account cache.
    // Join their current refresh: a second range must not invalidate the
    // first range's read and leave only an older, shorter range admitted.
    // Only actual change-feed invalidation retires completed observations via
    // revision. A progress refresh retires only an older unfinished load.
    if (refreshing) return refreshing;
    const reload = async () => {
      loaded = null;
      const previous = pending;
      pending = null;
      if (previous) await previous;
      return read();
    };
    const work = reload();
    refreshing = work;
    try { return await work; }
    finally { if (refreshing === work) refreshing = null; }
  };
  const readCurrent = async (options?: Readonly<{ refresh?: boolean }>, revalidateCurrent?: () => boolean | Promise<boolean>): Promise<SessionFollowRuleCacheSnapshot> => {
    if (!current()) return { status: 'unavailable', reason: 'account-retired' };
    const observation = await (options?.refresh ? refresh() : read());
    // Account authority may itself await Home. Keep the observed revision
    // until that check settles, without withdrawing another range's refresh.
    if ((revalidateCurrent && !await revalidateCurrent()) || !current()) return { status: 'unavailable', reason: 'account-retired' };
    if (observation.snapshot.status === 'available' && observation.revision !== revision) return { status: 'unavailable', reason: 'rules-changed' };
    return observation.snapshot;
  };
  const hasEnabledSessionReceiver = (snapshot: SessionFollowRuleCacheSnapshot, sessionId: string): boolean =>
    snapshot.status === 'available' && snapshot.rules.some(rule => rule.definition.enabled
      && rule.receiver.kind === 'session' && rule.receiver.sessionId === sessionId);
  return {
    read: readCurrent,
    async hasEnabledSessionReceiver(sessionId: string, revalidateCurrent?: () => boolean | Promise<boolean>): Promise<boolean> {
      if (!current()) return false;
      // A known absence only suppresses work; it grants no authority or data.
      // The existing Account-feed invalidation clears this same observation
      // when rules change or the connection loses continuity.
      if (loaded?.snapshot.status === 'available' && !hasEnabledSessionReceiver(loaded.snapshot, sessionId)) return false;
      return hasEnabledSessionReceiver(await readCurrent(undefined, revalidateCurrent), sessionId);
    },
    dispose,
  };
}
