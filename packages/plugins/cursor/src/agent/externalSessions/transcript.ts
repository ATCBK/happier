import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionUnsupportedTranscriptItem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord, parseTimestampMs } from '@happier-dev/plugin-sdk';

/** Cursor's captured role/content dialect has no record-version tag. */
export function decodeCursorNativeRecord(data: unknown, offset: number, fallbackTime: number): Readonly<{
  item: AgentExternalSessionTranscriptItem; text?: string; partial: boolean;
}> {
  const id = `cursor:${offset}`;
  const unsupported = () => ({ item: createExternalSessionUnsupportedTranscriptItem({ agentId: 'cursor', id, createdAtMs: fallbackTime }), partial: true });
  if (!isRecord(data) || Object.keys(data).some(key => !['role', 'message', 'content', 'timestamp'].includes(key))
    || (data.role !== 'user' && data.role !== 'assistant')) return unsupported();
  const message = isRecord(data.message) ? data.message : null;
  if (message && Object.keys(message).some(key => key !== 'content')) return unsupported();
  const content = message?.content ?? data.content;
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.every(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string')) {
    text = content.map(block => block.text).join('\n');
  } else return unsupported();
  const createdAtMs = parseTimestampMs(data.timestamp) ?? fallbackTime;
  return { partial: false, text, item: { id, createdAtMs, messageRole: data.role === 'user' ? 'user' : 'agent',
    raw: data.role === 'user' ? { role: 'user', content: { type: 'text', text } }
      : { role: 'agent', content: { type: 'acp', agentId: 'cursor', data: { type: 'message', message: text } } } } };
}

export type CursorFileWitness = Readonly<{ identity: string; size: number; modified: string; prefix: string }>;
export async function cursorFileWitness(path: string, end: number | undefined, signal: AbortSignal, previous?: CursorFileWitness): Promise<CursorFileWitness> {
  signal.throwIfAborted();
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Cursor source is not a regular file');
  const size = end ?? Number(info.size);
  if (BigInt(size) > info.size) throw new Error('Cursor source shrank');
  const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  const modified = `${info.mtimeNs}:${info.ctimeNs}`;
  // Filesystem identity plus nanosecond modification evidence can reuse this
  // very cursor's integrity witness. An append/edit still verifies its prefix.
  if (previous?.identity === identity && previous.modified === modified && previous.size === size) return previous;
  const hash = createHash('sha256');
  let read = 0;
  if (size > 0) {
    const stream = createReadStream(path, { start: 0, end: size - 1, signal });
    try { for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk); read += chunk.length; } }
    finally { stream.destroy(); }
  }
  if (read !== size) throw new Error('Cursor source changed while reading');
  return { identity, size, modified, prefix: hash.digest('base64url') };
}

export type CursorTranscriptCursor = Readonly<{
  v: 1; kind: 'cursorTranscript'; homeDir: string; id: string; position: number; witness: CursorFileWitness;
}>;
export const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeTranscriptCursor(raw: string): CursorTranscriptCursor | null {
  try {
    const data: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!isRecord(data) || data.v !== 1 || data.kind !== 'cursorTranscript' || typeof data.homeDir !== 'string'
      || typeof data.id !== 'string' || typeof data.position !== 'number' || !Number.isSafeInteger(data.position) || data.position < 0
      || !isRecord(data.witness)) return null;
    const w = data.witness;
    if (typeof w.identity !== 'string' || typeof w.size !== 'number' || !Number.isSafeInteger(w.size) || w.size < 0
      || typeof w.prefix !== 'string' || typeof w.modified !== 'string' || data.position > w.size) return null;
    return { v: 1, kind: 'cursorTranscript', homeDir: data.homeDir, id: data.id, position: data.position,
      witness: { identity: w.identity, size: w.size, prefix: w.prefix, modified: w.modified } };
  } catch { return null; }
}
