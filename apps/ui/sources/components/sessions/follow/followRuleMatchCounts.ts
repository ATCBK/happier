import * as React from 'react';
import type { FollowRulePreviewResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRulePreviewV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { executeSessionFollowAction } from '@/sync/api/session/sessionFollowApi';
import { t } from '@/text';

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
 * editor reads, never a local match. A rule is re-counted only when its filter changes.
 */
export function useFollowRuleMatchCounts(
  serverId: string | null,
  receiverSessionId: string,
  rules: readonly Readonly<{ key: string; filter: SessionListFilterV1 }>[],
): Readonly<Record<string, FollowRuleMatchCount>> {
  const [counts, setCounts] = React.useState<
    Readonly<Record<string, FollowRuleMatchCount>>
  >({});
  const signature = JSON.stringify([
    serverId,
    receiverSessionId,
    rules.map((rule) => [rule.key, rule.filter]),
  ]);
  const rulesRef = React.useRef(rules);
  rulesRef.current = rules;
  React.useEffect(() => {
    if (!serverId) return;
    const controller = new AbortController();
    for (const rule of rulesRef.current) {
      setCounts((previous) => ({
        ...previous,
        [rule.key]: { status: 'loading' },
      }));
      void executeSessionFollowAction(
        'follow.preview',
        {
          receiver: { kind: 'session', sessionId: receiverSessionId },
          filter: rule.filter,
        },
        serverId,
        controller.signal,
      ).then((result) => {
        if (controller.signal.aborted) return;
        setCounts((previous) => ({
          ...previous,
          [rule.key]:
            result.kind === 'ok'
              ? { status: 'ready', preview: result.value }
              : { status: 'unavailable' },
        }));
      });
    }
    return () => controller.abort();
    // The signature is the rules' identity; a new array with the same rules re-counts nothing.
  }, [signature]);
  return counts;
}
