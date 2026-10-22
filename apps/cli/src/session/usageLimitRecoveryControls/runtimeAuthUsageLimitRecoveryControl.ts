import type { SessionUsageLimitRecoveryResumePromptModeV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { readSessionUsageLimitRecoveryForIssue } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import { normalizeUsageLimitRecoveryOperationResult } from './sessionUsageLimitRecoveryOperationResult';

export type CheckRuntimeAuthUsageLimitRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
}>) => Promise<unknown> | unknown;

export type ReadCurrentUsageLimitRecoveryIssue = (sessionId: string) => Promise<SessionRuntimeIssueV1 | null>;

export function readRuntimeAuthUsageLimitRecoveryAttemptId(metadata: unknown, currentIssue?: SessionRuntimeIssueV1 | null): string | null {
  const recovery = readSessionUsageLimitRecoveryForIssue(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'sessionUsageLimitRecoveryV1' in metadata
      ? metadata.sessionUsageLimitRecoveryV1 : null, currentIssue,
  );
  return recovery?.runtimeAuthRecoveryAttemptId ?? null;
}

/** Null leaves the current failure with local controls; an associated daemon attempt keeps custody. */
export async function routeRuntimeAuthUsageLimitRecoveryCheckNow(input: Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>> | null;
  currentIssue?: SessionRuntimeIssueV1 | null;
  readCurrentUsageLimitRecoveryIssue?: ReadCurrentUsageLimitRecoveryIssue | null;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  checkRuntimeAuthUsageLimitRecovery?: CheckRuntimeAuthUsageLimitRecovery | null;
}>): Promise<ReturnType<typeof normalizeUsageLimitRecoveryOperationResult> | null> {
  const storedAttemptId = readRuntimeAuthUsageLimitRecoveryAttemptId(input.metadata);
  if (!storedAttemptId) return null;
  let currentIssue = input.currentIssue;
  if (input.readCurrentUsageLimitRecoveryIssue) {
    try {
      currentIssue = await input.readCurrentUsageLimitRecoveryIssue(input.sessionId);
    } catch {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false, status: 'session_unreachable',
        errorCode: 'session_usage_limit_recovery_control_session_unavailable',
      }, { sessionId: input.sessionId });
    }
  }
  const attemptId = readRuntimeAuthUsageLimitRecoveryAttemptId(input.metadata, currentIssue);
  if (!attemptId) return null;
  const result = input.checkRuntimeAuthUsageLimitRecovery
    ? await input.checkRuntimeAuthUsageLimitRecovery({
        sessionId: input.sessionId, attemptId,
        ...(input.resumePromptMode !== undefined ? { resumePromptMode: input.resumePromptMode } : {}),
      })
    : { ok: false, errorCode: 'session_usage_limit_recovery_control_inactive' };
  return normalizeUsageLimitRecoveryOperationResult(result, { sessionId: input.sessionId });
}
