import type { SessionUsageLimitRecoveryResumePromptModeV1 } from '@happier-dev/protocol';
import { SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';

import { normalizeUsageLimitRecoveryOperationResult } from './sessionUsageLimitRecoveryOperationResult';

export type CheckRuntimeAuthUsageLimitRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
}>) => Promise<unknown> | unknown;

export function readRuntimeAuthUsageLimitRecoveryAttemptId(metadata: unknown): string | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'sessionUsageLimitRecoveryV1' in metadata
      ? metadata.sessionUsageLimitRecoveryV1 : null,
  );
  return parsed.success ? parsed.data.runtimeAuthRecoveryAttemptId ?? null : null;
}

/** Null means provider-local recovery; a daemon-owned attempt never falls through to that path. */
export async function routeRuntimeAuthUsageLimitRecoveryCheckNow(input: Readonly<{
  sessionId: string;
  metadata: Readonly<Record<string, unknown>> | null;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  checkRuntimeAuthUsageLimitRecovery?: CheckRuntimeAuthUsageLimitRecovery | null;
}>): Promise<ReturnType<typeof normalizeUsageLimitRecoveryOperationResult> | null> {
  const attemptId = readRuntimeAuthUsageLimitRecoveryAttemptId(input.metadata);
  if (!attemptId) return null;
  const result = input.checkRuntimeAuthUsageLimitRecovery
    ? await input.checkRuntimeAuthUsageLimitRecovery({
        sessionId: input.sessionId, attemptId,
        ...(input.resumePromptMode !== undefined ? { resumePromptMode: input.resumePromptMode } : {}),
      })
    : { ok: false, errorCode: 'session_usage_limit_recovery_control_inactive' };
  return normalizeUsageLimitRecoveryOperationResult(result, { sessionId: input.sessionId });
}
