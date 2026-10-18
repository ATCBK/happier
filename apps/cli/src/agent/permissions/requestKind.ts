import { resolveAgentRequestKind as resolveProtocolAgentRequestKind, type AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';

export type { AgentRequestKind };

/** Host Action confirmation shares request delivery, never native tool policy. */
export const HAPPIER_ACTION_REQUEST_SOURCE = 'happier_action';

export function resolveAgentRequestKind(toolName: string): AgentRequestKind {
  const normalized = typeof toolName === 'string' ? toolName.trim() : '';
  return resolveProtocolAgentRequestKind({ toolName: normalized });
}
