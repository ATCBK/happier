import type { UsageCoachFinding } from '@happier-dev/protocol/usage/coach/coachFinding';
import type { UsageCoachSnapshot } from './usageCoachController';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { readUsageCoverageGaps } from './usageBodyKit';

/** Evidence activity is independent of whether a previous evaluation is retained as stale. */
export function readUsageCoachState(slice: UsageQueryResultSlice): 'reading' | 'ready' | 'unavailable' {
  const sources = slice.shownQuery.includeSessionEvidence ? ['accounting', 'how_you_work'] : ['accounting'];
  if (readUsageCoverageGaps(slice, sources).some(source => source.status === 'pending' || source.status === 'not_loaded'))
    return 'reading';
  return slice.coach ? 'ready' : 'unavailable';
}

/** Project the mounted rows from finding state and acknowledged Action receipts. */
export function projectUsageCoachFindings(findings: readonly UsageCoachFinding[], snapshot: UsageCoachSnapshot, nowMs: number) {
  const visible = findings.filter(finding => !finding.state.dismissed
    && !(finding.state.snoozedUntilMs !== null && finding.state.snoozedUntilMs > nowMs));
  return { visible, suppressed: findings.filter(finding => !visible.includes(finding)),
    appliedOnly: snapshot.applied.filter(entry => !visible.some(finding => finding.evidenceKey === entry.evidenceKey)) };
}
