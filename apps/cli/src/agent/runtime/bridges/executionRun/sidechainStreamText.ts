import type { ExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';

export function createExecutionRunSidechainStreamText(profile: ExecutionRunIntentProfile): (fullText: string) => string | null {
  return (fullText: string): string | null => profile.computeSidechainStreamText?.({ fullText }) ?? fullText;
}

/** Native durable messages use the same intent projection as legacy streamed text. */
export function projectExecutionRunTranscriptBody(profile: ExecutionRunIntentProfile, body: ACPMessageData): ACPMessageData {
  if (body.type !== 'message' || !profile.computeSidechainStreamText) return body;
  const message = profile.computeSidechainStreamText({ fullText: body.message });
  if (message === body.message) return body;
  if (message.trim().length > 0) return { ...body, message };
  // Preserve durable source identity without introducing an empty assistant row.
  return { type: 'output', data: { type: 'progress', marker: 'source_fact_consumed', reason: 'host_structured_output' },
    ...(body.sidechainId ? { sidechainId: body.sidechainId } : {}) };
}
