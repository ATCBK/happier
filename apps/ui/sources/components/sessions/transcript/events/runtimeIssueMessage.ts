/**
 * True for a message the host's failure projector committed (`runtimeFailureTranscript.ts`): a typed
 * turn failure or input rejection that rides the ordinary agent-message body. The message meta schema
 * keeps `source` and `runtimeIssueCode`, and only that projector writes the pair.
 */
export function isRuntimeIssueMessageMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') return false;
  const record = meta as Record<string, unknown>;
  return record.source === 'runtime' && typeof record.runtimeIssueCode === 'string';
}
