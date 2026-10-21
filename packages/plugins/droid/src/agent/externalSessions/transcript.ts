import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readJsonlFileForward } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { AgentExternalSessionTranscriptRawRecordSchema, type AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { DroidReadError } from './source.js';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('base64url'); }
export function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decode(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (record(parsed)) return parsed; } catch {}
  throw new DroidReadError('invalid_request', 'Invalid Droid transcript continuation.');
}
export function index(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
type NativeRow = { value: Record<string, unknown>; parentId: string | null; id: string };
export type DroidTranscript = {
  sessionId: string; title?: string; cwd?: string; createdAtMs?: number; updatedAtMs: number;
  items: AgentExternalSessionTranscriptItem[]; texts: string[]; partial: boolean;
  bytes: Buffer; identity: string; digest: string;
};
function visible(row: NativeRow): boolean {
  const message = row.value.message;
  return record(message) && message.visibility === undefined && message.hookEventName === undefined
    && (message.role === 'user' || message.role === 'assistant');
}
function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(record).filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => String(part.text)).join('\n');
}
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key));
}
function normalize(row: NativeRow, fileKey: string): { item: AgentExternalSessionTranscriptItem; text: string }[] {
  if (!visible(row) || !record(row.value.message)) return [];
  const message = row.value.message;
  const createdAtMs = typeof row.value.timestamp === 'string' ? Date.parse(row.value.timestamp) : 0;
  const content = message.content;
  const text = textBlocks(content);
  const base = { createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0 };
  const projected: { item: AgentExternalSessionTranscriptItem; text: string }[] = [];
  if (text.trim()) projected.push({ text, item: { ...base, id: `${fileKey}:${row.id}:text`,
    messageRole: message.role === 'user' ? 'user' : 'agent',
    ...(message.role === 'user' ? { userProjection: 'source_fact' as const } : {}),
    raw: message.role === 'user' ? { role: 'user', content: { type: 'text', text } }
      : { role: 'agent', content: { type: 'acp', agentId: 'droid', data: { type: 'message', message: text } } } } });
  // Tool input, thinking and documents never become searchable prose. A true
  // tool result is a separate canonical tool row, retained for Memory's existing
  // includeToolOutput policy rather than relabelled as a human message.
  if (Array.isArray(content)) for (const [partIndex, part] of content.entries()) {
    if (!record(part)) continue;
    if (part.type === 'tool_use' && typeof part.name === 'string') {
      const raw = AgentExternalSessionTranscriptRawRecordSchema.safeParse({ role: 'agent', content: { type: 'acp', agentId: 'droid', data: {
        type: 'tool-call', callId: typeof part.id === 'string' ? part.id : row.id,
        name: part.name, input: part.input ?? {},
      } } });
      if (raw.success) projected.push({ text: '', item: { ...base, id: `${fileKey}:${row.id}:call:${partIndex}`, messageRole: 'event', raw: raw.data } });
      continue;
    }
    if (part.type !== 'tool_result') continue;
    const output = textBlocks(part.content);
    if (!output.trim()) continue;
    projected.push({ text: output, item: { ...base, id: `${fileKey}:${row.id}:tool:${partIndex}`, messageRole: 'event',
      raw: { role: 'agent', content: { type: 'acp', agentId: 'droid', data: {
        type: 'tool-result', callId: typeof part.tool_use_id === 'string' ? part.tool_use_id : row.id,
        output, ...(part.is_error === true ? { isError: true } : {}),
      } } } } });
  }
  return projected;
}
/** Schema 2 is characterized by the pinned 0.170.0 native fixture. Parent links
 * and visibility are semantic authority; upstream's flat fold is not used. */
export async function readDroidTranscript(filePath: string, signal: AbortSignal): Promise<DroidTranscript> {
  signal.throwIfAborted();
  const before = await stat(filePath);
  const bytes = await readFile(filePath, { signal });
  const after = await stat(filePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== after.size) throw new DroidReadError('unavailable', 'Droid transcript changed while reading.');
  // The observed file size owns this read. No preview limit may truncate valid
  // long messages. The SDK scanner retains malformed/torn-tail diagnostics.
  const parsed = await readJsonlFileForward({ filePath, offsetBytes: 0, maxBytes: bytes.length || 1,
    maxItems: Number.MAX_SAFE_INTEGER, maxOversizeLineBytes: bytes.length || 1, includeMalformedRecords: true,
    fileSystem: { stat: async () => ({ size: bytes.length, mtimeMs: after.mtimeMs }),
      read: async (_path, position, length) => { signal.throwIfAborted(); return bytes.subarray(position, position + length); } } });
  const header = parsed.items[0]?.value;
  if (!record(header) || header.type !== 'session_start' || header.version !== 2 || typeof header.id !== 'string' || !header.id) {
    throw new DroidReadError('unsupported', 'Droid native transcript version is unsupported.');
  }
  const rows = new Map<string, NativeRow>();
  let leaf: NativeRow | undefined;
  let partial = Boolean(parsed.diagnostics?.length) || !parsed.reachedEnd || unknownKeys(header, [
    'type', 'id', 'version', 'title', 'owner', 'cwd', 'parent', 'lastCwd', 'organizationId',
    'isSessionTitleManuallySet', 'callingSessionId', 'callingToolUseId', 'forkedAtMessageId', 'hostId',
  ]);
  const knownBlocks = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'document', 'image']);
  for (const line of parsed.items.slice(1)) {
    signal.throwIfAborted();
    const value = line.value;
    if (!record(value) || value.type !== 'message' || typeof value.id !== 'string' || !value.id
      || (value.parentId !== undefined && value.parentId !== null && typeof value.parentId !== 'string') || !record(value.message)) { partial = true; continue; }
    const content = value.message.content;
    if (unknownKeys(value, ['type', 'id', 'parentId', 'timestamp', 'message'])
      || unknownKeys(value.message, ['role', 'content', 'visibility', 'hookEventName', 'modelId', 'reasoningEffort'])
      || !['user', 'assistant'].includes(String(value.message.role)) || (typeof content !== 'string' && !Array.isArray(content))
      || (Array.isArray(content) && content.some(part => !record(part) || !knownBlocks.has(String(part.type))))) partial = true;
    const row = { value, id: value.id, parentId: typeof value.parentId === 'string' ? value.parentId : null };
    if (rows.has(row.id)) { partial = true; continue; }
    rows.set(row.id, row);
    if (visible(row)) leaf = row;
  }
  const chain: NativeRow[] = [];
  const visited = new Set<string>();
  let current = leaf;
  while (current) {
    if (visited.has(current.id)) throw new DroidReadError('unsupported', 'Droid native transcript ancestry is cyclic.');
    visited.add(current.id); chain.push(current);
    if (current.parentId === null) break;
    const parent = rows.get(current.parentId);
    if (!parent) throw new DroidReadError('unsupported', 'Droid native transcript ancestry is incomplete.');
    current = parent;
  }
  const fileKey = digest(filePath);
  const projection = chain.reverse().flatMap(row => normalize(row, fileKey));
  signal.throwIfAborted();
  return { sessionId: header.id, ...(typeof header.title === 'string' ? { title: header.title } : {}),
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}), updatedAtMs: Math.max(0, Math.trunc(after.mtimeMs)),
    ...(projection[0]?.item.createdAtMs ? { createdAtMs: projection[0].item.createdAtMs } : {}),
    items: projection.map(entry => entry.item), texts: projection.map(entry => entry.text), partial, bytes,
    identity: `${after.dev}:${after.ino}:${after.birthtimeMs}`, digest: digest(bytes) };
}
