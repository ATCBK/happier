/** Writer-built, sanitized fixture; not a captured native conversation.
 * @augmentcode/auggie 0.36.0, embedded commit 7c61e5bb; npm artifact SRI:
 * sha512-jb4kq97pGzG0i5UyISc//LjTVlFzIywwD+VfPemiSIl58KjLfxry3KDgxWYnr1vmV8yUkySVzjLnj4ewUEbT/Q==
 * augment.mjs UTF-16 offsets: saveSession 8379664+, pushExchange 7495098,
 * qL/gpe 7497201, SessionBackupStore 8377xxx. No vendor code is executed.
 */
type NativeNode = { id: number; type: number; [field: string]: unknown };
export function buildAuggieNativeSession(texts: readonly string[], sessionId = 'native-session') {
  return { sessionId, created: '2026-10-20T10:00:00.000Z', modified: '2026-10-20T10:01:00.000Z',
    title: 'ordinary title', agentState: { userGuidelines: '', workspaceGuidelines: '' },
    chatHistory: texts.map((text, index) => ({ completed: true, sequenceId: index + 1,
      finishedAt: new Date(1792490400000 + index).toISOString(), changedFiles: [], changedFilesSkipped: [],
      changedFilesSkippedCount: 0, source: 'local', exchange: {
        request_id: `request-${index + 1}`, request_message: text, response_text: 'ordinary reply',
        request_nodes: Array.of<NativeNode>({ id: 1, type: 0, text_node: { content: text } }),
        response_nodes: Array.of<NativeNode>({ id: 1, type: 0, content: 'ordinary reply' }),
      } })),
  };
}
