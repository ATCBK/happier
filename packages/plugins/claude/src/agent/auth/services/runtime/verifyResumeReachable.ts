import type {
  AgentConnectedAccountResumeReachabilityInputV1,
  AgentConnectedAccountResumeReachabilityResultV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { readClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';

const CLAUDE_SESSION_FILE_NOT_FOUND_REASON = 'claude_session_file_not_found';

export async function verifyResumeReachableClaude(
  input: AgentConnectedAccountResumeReachabilityInputV1,
): Promise<AgentConnectedAccountResumeReachabilityResultV1> {
  const vendorResumeId = readClaudeProviderIdentityValue(input.vendorResumeId);
  if (!vendorResumeId) {
    return { ok: false, reason: CLAUDE_SESSION_FILE_NOT_FOUND_REASON };
  }

  const candidate = await input.sessionFiles.findDeclaredCandidate({
    matchesCandidate: ({ fileName, nativeSessionId }) => (
      nativeSessionId === vendorResumeId
      || fileName === `${vendorResumeId}.jsonl`
    ),
  });
  return candidate.found
    ? { ok: true }
    : { ok: false, reason: CLAUDE_SESSION_FILE_NOT_FOUND_REASON };
}
