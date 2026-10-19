import type { SessionWorkStateV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';

function effectiveGoals(work: SessionWorkStateV1 | null) {
  return (work?.items ?? []).filter(item => item.kind === 'goal')
    .map(item => [item.id, item.title, item.status, item.tokenBudget ?? null] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
}

/** Usage, timestamps, replayed snapshots and unrelated work are not goal mutations. */
export function hasEffectiveSessionGoalChange(before: SessionWorkStateV1 | null, after: SessionWorkStateV1 | null): boolean {
  return JSON.stringify(effectiveGoals(before)) !== JSON.stringify(effectiveGoals(after));
}

