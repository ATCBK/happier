// Sanitised vectors derived from google-gemini/gemini-cli v0.64.0:
// packages/core/src/services/chatRecordingTypes.ts and chatRecordingService.ts
// (loadConversation, applySinglePatch, $rewindTo). No user store was read.
export const sessionId = '8b6e1959-546e-4a3b-a6c2-4c1d6109f210';
export const timestamp = '2026-10-20T10:00:00.000Z';
export const body = 'body-only sapphire "quoted"\n東京 café ' + 'long visible body '.repeat(300);
export const header = { sessionId, projectHash: 'project', startTime: timestamp, lastUpdated: timestamp };
export const user = (id: string, content: string) => ({ id, timestamp, type: 'user', content });
export const gemini = (id: string, content: string) => ({ id, timestamp, type: 'gemini', content });
export const records = [header, user('u1', 'ordinary title'), gemini('a1', body), {
  ...gemini('tools', ''), toolCalls: [{ id: 'call', name: 'read_file', args: { path: 'metadata-only topaz' },
    status: 'success', timestamp, result: [{ text: 'visible tool result' }] }],
}];
export function jsonl(rows: readonly unknown[] = records): string {
  return rows.map(row => JSON.stringify(row).replaceAll('東京', '\\u6771\\u4eac')).join('\n') + '\n';
}
