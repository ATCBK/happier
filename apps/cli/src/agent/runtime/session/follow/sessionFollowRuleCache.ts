import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { SessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { openSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import type { SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

export type SessionFollowRuleCacheSnapshot = Readonly<{ status: 'available'; rules: readonly OpenedSessionFollowRuleV1[]; defaultPreferences?: SessionAutoFollowPreferencesV1 }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

/** The admitted daemon owns this cache for one captured Account lifetime. */
export function createSessionFollowRuleCache(input: Readonly<{
  signal: AbortSignal; isCurrent: () => boolean;
  subscribeInvalidation: (listener: () => void) => () => void;
  read: () => Promise<Readonly<{ mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null; rules: readonly SessionFollowRuleV1[]; defaultPreferences?: SessionAutoFollowPreferencesV1 }> | null>;
}>) {
  let retired = false;
  let revision = 0;
  let loaded: SessionFollowRuleCacheSnapshot | null = null;
  let pending: Promise<SessionFollowRuleCacheSnapshot> | null = null;
  let refreshing: Promise<SessionFollowRuleCacheSnapshot> | null = null;
  const current = () => !retired && !input.signal.aborted && input.isCurrent();
  const invalidate = () => { revision++; loaded = null; };
  const unsubscribe = input.subscribeInvalidation(invalidate);
  const dispose = () => {
    if (retired) return;
    retired = true;
    invalidate();
    unsubscribe();
    input.signal.removeEventListener('abort', dispose);
  };
  input.signal.addEventListener('abort', dispose, { once: true });
  if (input.signal.aborted) dispose();
  const read = async (): Promise<SessionFollowRuleCacheSnapshot> => {
    if (!current()) return { status: 'unavailable', reason: 'account-retired' };
    if (loaded) return loaded;
    if (pending) return pending;
    const observedRevision = revision;
    const load = async (): Promise<SessionFollowRuleCacheSnapshot> => {
      try {
        const source = await input.read();
        if (!current()) return { status: 'unavailable', reason: 'account-retired' };
        if (revision !== observedRevision) return { status: 'unavailable', reason: 'rules-changed' };
        if (!source) return { status: 'unavailable', reason: 'private-rules-unavailable' };
        const rules: OpenedSessionFollowRuleV1[] = [];
        for (const row of source.rules) {
          const opened = openSessionFollowRuleContentV1({ ...row, mode: source.mode, material: source.material });
          if (opened.status !== 'opened') return { status: 'unavailable', reason: opened.reason };
          rules.push({ ruleId: row.ruleId, version: row.version, receiver: row.receiver, definition: opened.definition,
            ...(row.inception ? { inception: row.inception } : {}),
            ...(row.sources ? { sources: row.sources } : {}) });
        }
        // Unavailable is never memoized as an empty set; another source/change wake may repair it.
        loaded = { status: 'available', rules, ...(source.defaultPreferences ? { defaultPreferences: source.defaultPreferences } : {}) };
        return loaded;
      } catch {
        return { status: 'unavailable', reason: 'private-rules-unavailable' };
      }
    };
    const work = load();
    pending = work;
    try { return await work; }
    finally { if (pending === work) pending = null; }
  };
  return {
    async read(options?: Readonly<{ refresh?: boolean }>): Promise<SessionFollowRuleCacheSnapshot> {
      if (!current()) return { status: 'unavailable', reason: 'account-retired' };
      if (!options?.refresh) return read();
      // Source notifications and receiver catch-up share this Account cache.
      // Join their current refresh: a second range must not invalidate the
      // first range's read and leave only an older, shorter range admitted.
      // Actual change-feed invalidation still retires that read via revision.
      if (refreshing) return refreshing;
      const refresh = async () => {
        invalidate();
        if (pending) await pending;
        return read();
      };
      const work = refresh();
      refreshing = work;
      try { return await work; }
      finally { if (refreshing === work) refreshing = null; }
    },
    dispose,
  };
}
