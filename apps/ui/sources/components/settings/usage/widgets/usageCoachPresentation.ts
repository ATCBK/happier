import type { UsageCoachFinding } from '@happier-dev/protocol/usage/coach/coachFinding';
import type { UsageCoachSnapshot } from './usageCoachController';

/** Project the mounted rows from finding state and acknowledged Action receipts. */
export function projectUsageCoachFindings(findings: readonly UsageCoachFinding[], snapshot: UsageCoachSnapshot, nowMs: number) {
  const visible = findings.filter(finding => !finding.state.dismissed
    && !(finding.state.snoozedUntilMs !== null && finding.state.snoozedUntilMs > nowMs));
  return { visible, suppressed: findings.filter(finding => !visible.includes(finding)),
    appliedOnly: snapshot.applied.filter(entry => !visible.some(finding => finding.evidenceKey === entry.evidenceKey)) };
}
