import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import type { StoredCredentials } from '@/persistence';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { continueSessionAfterUsageLimitReset, type UsageLimitContinuationResult } from '../connectedServices/continuation/continueSessionAfterUsageLimitReset';

export type ActivateInactiveUsageLimitResumeParams = Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  customResumePrompt?: string | null;
  readiness?: 'provider_ready';
  nowMs?: number;
  isCurrent?: () => boolean | Promise<boolean>;
}>;

/**
 * Admit the ready usage-limit continuation through ordinary Pending. Its
 * canonical activation owner adopts or starts the hosted runtime.
 *
 * A Session whose transcript lives with an external Agent — or whose external
 * link exists but is unresolved — is owned by External Sessions takeover, so
 * recovery fails closed here. Plain unlinked sessions retain automatic recovery.
 */
export async function activateInactiveUsageLimitResume(
  params: ActivateInactiveUsageLimitResumeParams,
): Promise<boolean | UsageLimitContinuationResult> {
  const linkAuthority = resolveLinkedExternalSessionAuthorityV1(params.metadata);
  if (!linkAuthority.ok || linkAuthority.transcriptStorage === 'direct') {
    return false;
  }
  const recovery = SessionUsageLimitRecoveryV1Schema.safeParse(params.metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  if (!recovery.success) return false;
  const result = await continueSessionAfterUsageLimitReset({
    credentials: params.credentials, sessionId: params.sessionId,
    rawSession: params.rawSession, metadata: params.metadata, recovery: recovery.data,
    customResumePrompt: params.customResumePrompt,
    readiness: params.readiness,
    nowMs: params.nowMs ?? Date.now(),
    isCurrent: params.isCurrent ?? (() => true),
  });
  return result;
}
