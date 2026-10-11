import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

/** Stable issue identity shared by recovery producers and continuation qualification. */
export function buildUsageLimitIssueFingerprint(issue: SessionRuntimeIssueV1, fallbackAgentId = 'unknown-agent'): string {
  return [
    'usage-limit',
    issue.agentId ?? fallbackAgentId,
    issue.agentTurnId ?? 'unknown-turn',
    String(issue.occurredAt),
    String(issue.usageLimit?.resetAtMs ?? 'no-reset'),
  ].join(':');
}
