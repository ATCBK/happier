import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import { createExternalSessionUnsupportedTranscriptItem, readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { grokFile, GrokSourceError, readGrokSummary, record, type GrokSession } from './source.js';

export type GrokTranscriptRow = Readonly<{ item: AgentExternalSessionTranscriptItem; text?: string; partial?: boolean }>;
/** Both content search and transcript reads use this exact native projection.
 * XML-looking user text is not evidence of an injected envelope. Keep it
 * verbatim instead of applying upstream's generic hidden-tag/preview stripping. */
export function decodeGrokRecord(value: unknown, offset: number): GrokTranscriptRow | null {
  const id = `grok:byte:${offset}`;
  const createdAtMs = record(value) ? parseTimestampMs(value.timestamp) ?? 0 : 0;
  const unsupported = (): GrokTranscriptRow => ({ partial: true,
    item: createExternalSessionUnsupportedTranscriptItem({ agentId: 'grok', id, createdAtMs }) });
  if (!record(value) || !['user', 'assistant'].includes(String(value.type))
    || Object.keys(value).some(key => !['type', 'content', 'timestamp'].includes(key))) return unsupported();
  let text: string;
  if (typeof value.content === 'string') text = value.content;
  else if (Array.isArray(value.content)) {
    const pieces: string[] = [];
    for (const block of value.content) {
      if (!record(block)) return unsupported();
      if (block.type === 'text' && typeof block.text === 'string' && Object.keys(block).every(key => key === 'type' || key === 'text')) pieces.push(block.text);
      // Native invocation arguments/name/id are metadata, never prose hits.
      else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
        && Object.keys(block).every(key => ['type', 'id', 'name', 'input'].includes(key))) continue;
      else return unsupported();
    }
    text = pieces.join('\n');
  } else return unsupported();
  if (!text) return null;
  const user = value.type === 'user';
  return { text, item: { id, createdAtMs, messageRole: user ? 'user' : 'agent', raw: user
    ? { role: 'user', content: { type: 'text', text } }
    : { role: 'agent', content: { type: 'acp', agentId: 'grok', data: { type: 'message', message: text } } } } };
}
export function grokFileIdentity(info: Awaited<ReturnType<typeof stat>>): string { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
export function grokFileSnapshot(info: Awaited<ReturnType<typeof stat>>): string {
  return `${grokFileIdentity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export async function readGrokTranscript(root: string, session: GrokSession, signal: AbortSignal) {
  let path: string;
  try { path = await grokFile(root, session, 'chat_history.jsonl'); }
  catch (error) {
    // Missing bodies within available storage are authoritative absence;
    // unavailable storage and missing/unreadable sidecars are failed reads.
    if (record(error) && error.code === 'ENOENT' && (await stat(root).catch(() => null))?.isDirectory()) {
      throw new GrokSourceError('candidate_not_found');
    }
    throw error;
  }
  await readGrokSummary(root, session);
  const before = await stat(path);
  const rows: GrokTranscriptRow[] = [];
  let partial = false;
  const page = await readJsonlFileForwardLines({ filePath: path, offsetBytes: 0,
    maxBytes: Math.max(1, before.size), maxItems: Math.max(1, before.size), maxOversizeLineBytes: Math.max(1, before.size),
    onDiagnostic: () => { partial = true; },
    onLine(line) { signal.throwIfAborted(); const row = decodeGrokRecord(line.value, line.startOffsetBytes);
      if (row) { rows.push(row); partial ||= row.partial === true; } },
  });
  signal.throwIfAborted();
  if (grokFileSnapshot(before) !== grokFileSnapshot(await stat(path))) throw new GrokSourceError('source_invalid');
  return { rows, partial: partial || page.truncated || !page.reachedEnd, identity: grokFileIdentity(before) };
}
/** Includes every normalized item, so same-size rewrites and changed unsupported
 * row positions invalidate a retained prefix instead of appending stale history. */
export function grokPrefix(rows: readonly GrokTranscriptRow[], count: number): string {
  const hash = createHash('sha256');
  for (let index = 0; index < count; index++) hash.update(JSON.stringify(rows[index]!.item)).update('\n');
  return hash.digest('base64url');
}
