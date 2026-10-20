// Sanitised contract fixture from QwenLM/qwen-code v0.25.3,
// b28b0d948fa28b89750ac5f1525b95e1746f47ab: chatRecordingService.ts,
// session-transcript-reader.ts, utils/transcript-records.ts and sessionService.ts.
// Writer-shaped records, never captured user history. Compression changes model
// context, not display history; rewind changes the active parent chain.
export const sessionId = '63c749ea-cbd3-4b3f-930b-669129cba743';
export const timestamp = '2026-10-20T10:00:00.000Z';
export const body = 'body-only sapphire "quotes"\n東京 café ' + 'ordinary '.repeat(1600) + 'long visible body';
export function record(uuid: string, parentUuid: string | null, type: 'user' | 'assistant' | 'tool_result' | 'system', fields: Record<string, unknown>) {
  return { uuid, parentUuid, sessionId, timestamp, type, cwd: '/repo', version: '0.25.3', ...fields };
}
export const records = [
  record('u1', null, 'user', { message: { role: 'user', parts: [{ text: 'ordinary title' }] } }),
  record('a1', 'u1', 'assistant', { message: { role: 'model', parts: [{ text: body }] } }),
  record('compression', 'a1', 'system', { subtype: 'chat_compression', systemPayload: {
    compressedHistory: [{ role: 'user', parts: [{ text: 'model-only compression secret' }] }],
  } }),
  record('tools', 'compression', 'assistant', { message: { role: 'model', parts: [
    { functionCall: { id: 'call', name: 'shell', args: { command: 'metadata-only topaz' } } },
  ] } }),
  record('result', 'tools', 'tool_result', { message: { role: 'user', parts: [
    { functionResponse: { id: 'call', name: 'shell', response: { output: 'visible tool emerald' } } },
  ] } }),
];
export function jsonl(values: readonly unknown[] = records) {
  return values.map(value => JSON.stringify(value).replaceAll('東京', '\\u6771\\u4eac')).join('\n') + '\n';
}
