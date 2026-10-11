import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

export function readLatestUsageLimitFailureIssue(rawSession: Readonly<{
  latestTurnStatus?: unknown;
  lastRuntimeIssue?: unknown;
}>): SessionRuntimeIssueV1 | null {
  if (rawSession.latestTurnStatus != null && rawSession.latestTurnStatus !== 'failed') return null;
  const parsed = SessionRuntimeIssueV1Schema.safeParse(rawSession.lastRuntimeIssue);
  return parsed.success && parsed.data.source === 'usage_limit' && parsed.data.usageLimit
    ? parsed.data : null;
}
