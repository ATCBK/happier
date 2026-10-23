/**
 * Sidechain (subagent) attribution for Claude Code hook records (ported R-11 / HF-3 / HF-7).
 *
 * Claude Code marks hook events emitted by subagents with an `agent_id` field on the raw hook
 * record. Sidechain-attributed hooks must never drive PRIMARY-session effects (turn lifecycle,
 * transcript re-keying, provider session identity); per-request permission accounting and
 * account-level usage evidence remain valid from sidechains (the carve-outs).
 */

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readSessionHookSidechainAgentId(
  record: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  if (!record || typeof record !== 'object') return null;
  return readNonEmptyString(record.agent_id) ?? readNonEmptyString(record.agentId);
}

export function isSidechainSessionHook(
  record: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return readSessionHookSidechainAgentId(record) !== null;
}

/** Scope carried by Claude SDK and JSONL records; hook agent attribution is a separate producer contract. */
export function isClaudeSidechainRuntimeEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const parentToolUseId = record.parent_tool_use_id ?? record.parentToolUseId;
  return record.isSidechain === true
    || (typeof parentToolUseId === 'string' && parentToolUseId.trim().length > 0);
}
