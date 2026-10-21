import * as React from 'react';
import type { FollowRulePreviewResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { executeSessionFollowAction } from '@/sync/api/session/sessionFollowApi';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { t } from '@/text';
import { isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';

export type FollowRuleMatchCount = Readonly<
  | { status: 'loading' }
  | { status: 'ready'; preview: FollowRulePreviewResultV1 }
  | { status: 'unavailable' }
>;

/** "Matches 4 now · <level>": the count line every rule row and suggestion shows, honest about partial reads. */
export function describeFollowRuleMatchCount(
  count: FollowRuleMatchCount | undefined,
  level: string,
): string {
  if (!count || count.status === 'loading')
    return t('sessionCoordinator.make.countLoading', { level });
  if (
    count.status === 'unavailable' ||
    count.preview.coverage === 'unavailable'
  )
    return t('sessionCoordinator.make.countUnavailable', { level });
  return count.preview.coverage === 'partial'
    ? t('sessionCoordinator.make.countAtLeast', {
        count: count.preview.matchCount,
        level,
      })
    : t('sessionCoordinator.make.count', {
        count: count.preview.matchCount,
        level,
      });
}

/**
 * Live counts for rules this Session would follow, keyed by the caller's id: the same `follow.preview` the rule
 * editor reads, never a local match. Filter and captured-Home source changes invalidate that preview.
 */
export function useFollowRuleMatchCounts(
  serverId: string | null,
  receiverSessionId: string,
  rules: readonly Readonly<{ key: string; filter: SessionListFilterV1 }>[],
): Readonly<Record<string, FollowRuleMatchCount>> {
  const activeScope = useActiveServerAccountScope();
  const currentScope = rules.length ? selectActiveServerAccountScopeForServer(activeScope, serverId) : null;
  const { binding } = useServerCredentialAccountScopeBinding(rules.length && !currentScope ? serverId : null);
  const lifetime = currentScope ? captureActiveServerAccountScopeLifetime() : binding;
  const accountId = currentScope?.accountId ?? binding?.accountId;
  const [state, setState] = React.useState<Readonly<{
    key: string;
    counts: Readonly<Record<string, FollowRuleMatchCount>>;
  }>>({ key: '', counts: {} });
  const signature = JSON.stringify([
    serverId,
    receiverSessionId,
    accountId, binding?.revision,
    rules.map((rule) => [rule.key, rule.filter]),
  ]);
  const rulesRef = React.useRef(rules);
  rulesRef.current = rules;
  React.useEffect(() => {
    if (!serverId || !lifetime?.isCurrent() || !rulesRef.current.length) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && lifetime.isCurrent();
    const retirement = lifetime.onRetire(() => {
      controller.abort();
      setState({ key: signature, counts: {} });
    });
    let running = false;
    let dirty = false;
    const read = () => {
      if (!isCurrent()) return;
      if (running) { dirty = true; return; }
      running = true;
      void (async () => {
        try {
          do {
            dirty = false;
            await Promise.all(rulesRef.current.map(async (rule) => {
              setState(previous => ({ key: signature, counts: {
                ...(previous.key === signature ? previous.counts : {}),
                [rule.key]: previous.key === signature && previous.counts[rule.key]?.status === 'ready'
                  ? previous.counts[rule.key] : { status: 'loading' },
              } }));
              let count: FollowRuleMatchCount;
              try {
                const result = await executeSessionFollowAction('follow.preview', {
                  receiver: { kind: 'session', sessionId: receiverSessionId }, filter: rule.filter,
                }, serverId, controller.signal, accountId);
                count = result.kind === 'ok' ? { status: 'ready', preview: result.value } : { status: 'unavailable' };
              } catch { count = { status: 'unavailable' }; }
              if (isCurrent()) setState(previous => ({ key: signature, counts: { ...previous.counts, [rule.key]: count } }));
            }));
          } while (dirty && isCurrent());
        } finally { running = false; }
      })();
    };
    const unsubscribe = subscribeHomeAccountChange(event => {
      if (isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, serverId)
        && isSessionFollowAccountChangeRelevant(event)) read();
    });
    read();
    return () => { controller.abort(); retirement.dispose(); unsubscribe(); };
    // Equal rule arrays retain their useful read; only scope/definition changes retire it.
  }, [signature, lifetime]);
  return lifetime?.isCurrent() && state.key === signature ? state.counts : {};
}
