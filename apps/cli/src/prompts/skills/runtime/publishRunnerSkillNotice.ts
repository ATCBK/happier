import { SESSION_CAPABILITY_NOTICE_SIDECAR_KEY, SessionCapabilityNoticeV1Schema, type SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { logger } from '@/ui/logger';
import type { RunnerSkillsResult } from './resolveRunnerSkills';

/** Skills failures stay visible without refusing an otherwise usable Session. */
export async function publishRunnerSkillNotice(
  session: Pick<ApiSessionClient, 'enqueueSessionEventCommitted'>,
  result: RunnerSkillsResult,
  skillsDelivered?: boolean,
): Promise<void> {
  // Startup resolution already published unavailable items. Native-open refusal
  // publishes only the delivered set it newly refused, without a dedupe ledger.
  const failed = result.plan.items.filter(item => skillsDelivered === false
    ? item.state === 'delivered' : item.state === 'unavailable');
  const nativeDisablesRefused = skillsDelivered === false && result.delivery?.items.length === 0
    && (result.delivery?.nativeDisables.length ?? 0) > 0;
  if (failed.length === 0 && !nativeDisablesRefused
    && (skillsDelivered === false || !result.unavailable && result.plan.diagnostics.length === 0)) return;
  const items: SessionCapabilityNoticeV1['items'] = failed.map(item => ({ kind: 'skill', name: item.name, itemId: item.skillId,
      code: 'skills_unavailable', detail: skillsDelivered === false && item.state === 'delivered' ? 'launch_path_unsupported'
        : result.failureDetails?.find(failure => failure.skillId === item.skillId)?.detail ?? item.reason }));
  if (nativeDisablesRefused) items.push({ kind: 'skill', name: 'Skills', code: 'skills_unavailable', detail: 'launch_path_unsupported' });
  if (items.length === 0) items.push({ kind: 'skill', name: 'Skills', code: 'skills_unavailable',
    detail: result.unavailableReason ?? result.plan.diagnostics[0]?.kind ?? 'skill_preparation_failed' });
  await commitSkillNotice(session, { v: 1, items });
}

/** Reports a concrete Session launch's refusal for the exact supplied delivered set. */
export async function publishSkillLaunchNotice(
  session: Pick<ApiSessionClient, 'enqueueSessionEventCommitted'>,
  delivery: NonNullable<AgentSessionOpenRequest['skills']>,
): Promise<void> {
  if (delivery.items.length === 0 && delivery.nativeDisables.length === 0) return;
  await commitSkillNotice(session, { v: 1, items: delivery.items.length > 0 ? delivery.items.map(item => ({
    kind: 'skill' as const, name: item.name, itemId: item.skillId,
    code: 'skills_unavailable', detail: 'launch_path_unsupported',
  })) : [{ kind: 'skill', name: 'Skills', code: 'skills_unavailable', detail: 'launch_path_unsupported' }] });
}

async function commitSkillNotice(
  session: Pick<ApiSessionClient, 'enqueueSessionEventCommitted'>,
  input: SessionCapabilityNoticeV1,
): Promise<void> {
  const notice = SessionCapabilityNoticeV1Schema.parse(input);
  try {
    // This optional warning has no delivery-dependent caller. Keep durable
    // admission here; the existing stable-identity journal owns Home delivery.
    await session.enqueueSessionEventCommitted({ type: 'message',
      message: notice.items.map(item => `${item.name} couldn't load · ${item.detail ?? item.code}`).join('\n'),
      [SESSION_CAPABILITY_NOTICE_SIDECAR_KEY]: notice }, undefined, { awaitDelivery: false });
  } catch {
    logger.warn('[skills] Session capability notice could not be committed');
  }
}
