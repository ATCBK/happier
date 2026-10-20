import type { MemoryFactV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';

import { useKnownAccountActor } from '@/components/account/useKnownAccountActor';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

export function formatMemoryDate(ms: number): string {
  return formatWithCachedDateTimeFormatter(ms, getPreferredLanguage(), {
    month: 'short',
    day: 'numeric',
  });
}

/** Stored approval is attribution evidence; a source-less note carries no author evidence. */
export function useMemoryFactAttribution(fact: MemoryFactV1, serverId: string | null): Readonly<{
  savedLabel: string;
  rowApproval: string | null;
  detailApproval: string | null;
}> {
  const approvedBy = fact.decision?.approvedBy;
  const { actor, viewerScope } = useKnownAccountActor(serverId, approvedBy?.accountId);
  const savedLabel = formatMemoryDate(fact.createdAtMs);
  if (!fact.decision) return { savedLabel, rowApproval: null, detailApproval: null };
  if (!approvedBy) {
    const label = t('memoryContext.memory.decisionNotApproved');
    return { savedLabel, rowApproval: label, detailApproval: label };
  }
  const date = formatMemoryDate(approvedBy.atMs);
  if (viewerScope?.accountId === approvedBy.accountId) {
    return { savedLabel,
      rowApproval: t('memoryContext.memory.decisionApprovedByYou'),
      detailApproval: t('memoryContext.memory.detailApprovedByYou', { date }),
    };
  }
  // The existing actor owner admits only this Home's currently applied, authorized profile.
  // Missing/former profiles stay neutral; neither document ownership nor a raw id supplies a name.
  const name = actor?.profile ? resolveAccountActorPresentation(actor, viewerScope).name : null;
  return { savedLabel,
    rowApproval: name
      ? t('memoryContext.memory.decisionApprovedByPerson', { name, date })
      : t('memoryContext.memory.decisionApproved', { date }),
    detailApproval: name
      ? t('memoryContext.memory.detailApprovedByPerson', { name, date })
      : t('memoryContext.memory.detailApprovedOn', { date }),
  };
}
