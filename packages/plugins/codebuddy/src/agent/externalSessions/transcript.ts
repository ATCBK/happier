import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import { createExternalSessionUnsupportedTranscriptItem, readJsonlFileBackwardPage, readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';
import { CodeBuddySourceError, isRecord } from './source.js';

// Pinned native CUSTOM_INPUT_ITEM_TYPES, plus its session-meta storage fact.
const facts = new Set(['custom-title', 'ai-title', 'file-history-snapshot', 'summary', 'topic', 'goal-result', 'goal-progress', 'turn-metrics', 'resend-fork-notice', 'acp-terminal-state', 'request-recovery', 'model-usage', 'credit-usage', 'session-meta']);
const chainTypes = new Set(['message', 'function_call', 'function_call_result', 'function_call_output', 'reasoning']);
type Stamp = { file: string; identity: string; revision: string; size: number; digest: string; replay: { branch: boolean; tip: string | null } };
type Cursor = { v: 1; mode: 'page' | 'tail'; stamp: Stamp; offset: number; expected: string | null; branch: boolean; tip: string | null; pending: boolean };
export type CodeBuddyTranscriptPage = { items: AgentExternalSessionTranscriptItem[]; nextCursor: string | null; tailCursor: string; partial: boolean; title?: string; cwd?: string };
export function encodeCursor(value: Cursor): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { throw new CodeBuddySourceError('invalid_request', 'Invalid CodeBuddy cursor.'); }
  if (!isRecord(parsed) || parsed.v !== 1 || (parsed.mode !== 'page' && parsed.mode !== 'tail') || !isRecord(parsed.stamp)
    || typeof parsed.stamp.file !== 'string' || typeof parsed.stamp.identity !== 'string' || typeof parsed.stamp.revision !== 'string' || typeof parsed.stamp.digest !== 'string'
    || typeof parsed.stamp.size !== 'number' || !Number.isSafeInteger(parsed.stamp.size) || parsed.stamp.size < 0
    || !isRecord(parsed.stamp.replay) || typeof parsed.stamp.replay.branch !== 'boolean' || (parsed.stamp.replay.tip !== null && typeof parsed.stamp.replay.tip !== 'string')
    || typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > parsed.stamp.size
    || typeof parsed.branch !== 'boolean' || (parsed.expected !== null && typeof parsed.expected !== 'string')
    || (parsed.tip !== null && typeof parsed.tip !== 'string') || typeof parsed.pending !== 'boolean') throw new CodeBuddySourceError('invalid_request', 'Invalid CodeBuddy cursor.');
  return { v: 1, mode: parsed.mode, stamp: { file: parsed.stamp.file, identity: parsed.stamp.identity, revision: parsed.stamp.revision, size: parsed.stamp.size, digest: parsed.stamp.digest, replay: { branch: parsed.stamp.replay.branch, tip: parsed.stamp.replay.tip } }, offset: parsed.offset, expected: parsed.expected, branch: parsed.branch, tip: parsed.tip, pending: parsed.pending };
}
async function digestPrefix(file: string, size: number, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  if (size > 0) {
    const stream = createReadStream(file, { start: 0, end: size - 1, signal });
    try { for await (const chunk of stream) { signal.throwIfAborted(); hash.update(chunk); } } finally { stream.destroy(); }
  }
  return hash.digest('base64url');
}
async function stampFile(file: string, signal: AbortSignal, prior?: Stamp): Promise<Stamp> {
  signal.throwIfAborted();
  const info = await stat(file, { bigint: true }).catch(() => null);
  if (!info?.isFile()) throw new CodeBuddySourceError('source_unavailable', 'CodeBuddy transcript is unavailable.');
  const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
  const revision = `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  if (prior && (prior.file !== file || prior.identity !== identity || info.size < BigInt(prior.size))) throw new CodeBuddySourceError('source_discontinuity', 'CodeBuddy transcript was rewritten.');
  // The cursor carries this observation, not a second process-wide cache.
  // Unchanged native files need only stat; changed stats still prove the exact
  // captured prefix so growth cannot conceal a rewrite of earlier messages.
  if (prior?.revision === revision) return prior;
  if (prior && await digestPrefix(file, prior.size, signal) !== prior.digest) throw new CodeBuddySourceError('source_discontinuity', 'CodeBuddy transcript was rewritten.');
  const size = prior?.size ?? Number(info.size);
  if (prior) return { ...prior, revision };
  // Native default replay retains ordinary disconnected history. Only an
  // explicit resend/content-filter record selects a parent-chain projection.
  // Discover that decision and the exact prefix digest in one shared-scanner
  // pass, retaining scalar metadata rather than the transcript's bodies.
  let hasParent = false; let hasResend = false; let hasFilter = false;
  let tip: string | null = null; let pending: string | null | undefined;
  const hash = createHash('sha256');
  await readJsonlFileForwardLines({ filePath: file, offsetBytes: 0, maxBytes: Math.max(1, size), maxOversizeLineBytes: Math.max(1, size), maxItems: Number.MAX_SAFE_INTEGER,
    fileSystem: {
      stat: async () => ({ size, mtimeMs: Number(info.mtimeMs) }),
      read: async (_file, position, length) => {
        signal.throwIfAborted(); const handle = await open(file, 'r');
        try { const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, position); const bytes = buffer.subarray(0, result.bytesRead); hash.update(bytes); return bytes; }
        finally { await handle.close(); }
      },
    },
    onLine: line => {
      signal.throwIfAborted(); const value = line.value; if (!isRecord(value)) return;
      hasParent ||= typeof value.parentId === 'string';
      hasFilter ||= isRecord(value.providerData) && Boolean(value.providerData.contentFilterNotice);
      if (value.type === 'resend-fork-notice') { hasResend = true; pending = typeof value.parentId === 'string' ? value.parentId : null; }
      else if (!facts.has(String(value.type))) { pending = undefined; if (typeof value.id === 'string') tip = value.id; }
    },
  });
  return { file, identity, revision, size, digest: hash.digest('base64url'), replay: { branch: pending !== undefined || hasParent && (hasResend || hasFilter), tip: pending === undefined ? tip : pending } };
}
function textContent(value: unknown): { text: string; partial: boolean } {
  if (typeof value === 'string') return { text: value, partial: false };
  if (!Array.isArray(value)) return { text: '', partial: true };
  let partial = false;
  const text = value.flatMap(block => {
    if (!isRecord(block)) { partial = true; return []; }
    if (['input_text', 'output_text', 'text'].includes(String(block.type)) && typeof block.text === 'string') return [block.text];
    // Native media has no text projection. Unknown blocks must remain visible.
    if (!['input_image', 'input_audio', 'input_file'].includes(String(block.type))) partial = true;
    return [];
  }).join('\n');
  return { text, partial };
}
function project(value: unknown, position: number): { items: AgentExternalSessionTranscriptItem[]; partial: boolean } {
  const id = isRecord(value) && typeof value.id === 'string' && value.id ? value.id : `byte:${position}`;
  const createdAtMs = isRecord(value) ? parseTimestampMs(value.timestamp) ?? 0 : 0;
  const unsupported = () => createExternalSessionUnsupportedTranscriptItem({ agentId: 'codebuddy', id: `${id}:unsupported`, createdAtMs });
  if (!isRecord(value) || value.version !== undefined || value.schemaVersion !== undefined) return { items: [unsupported()], partial: true };
  if (facts.has(String(value.type)) || value.type === 'reasoning' || value.type === 'function_call') return { items: [], partial: false };
  const role = value.type === 'message' && value.role === 'user' ? 'user' : value.type === 'message' && value.role === 'assistant' ? 'agent' : null;
  const tool = value.type === 'function_call_result' || value.type === 'function_call_output';
  if (!role && !tool) {
    if (value.type === 'message' && value.role === 'system') return { items: [], partial: false };
    return { items: [unsupported()], partial: true };
  }
  const body = textContent(tool ? value.output : value.content);
  const items: AgentExternalSessionTranscriptItem[] = [];
  if (body.text) items.push({ id, createdAtMs, messageRole: role === 'user' ? 'user' : tool ? 'event' : 'agent',
    ...(role === 'user' ? { userProjection: 'source_fact' as const } : {}),
    raw: role === 'user' ? { role: 'user', content: { type: 'text', text: body.text } }
      : { role: 'agent', content: { type: 'acp', agentId: 'codebuddy', data: tool
        ? { type: 'tool-result', id, callId: typeof value.callId === 'string' ? value.callId : id, output: body.text }
        : { type: 'message', message: body.text } } } });
  if (body.partial) items.push(unsupported());
  return { items, partial: body.partial };
}

/** A bounded backward walk over the native active parent chain. No body cache. */
export async function pageCodeBuddyTranscript(params: { file: string; cursor?: string; maxItems: number; maxSerializedBytes: number; signal: AbortSignal }): Promise<CodeBuddyTranscriptPage> {
  const previous = params.cursor ? decodeCursor(params.cursor) : null;
  if (previous && previous.mode !== 'page') throw new CodeBuddySourceError('invalid_request', 'Expected a CodeBuddy page cursor.');
  const stamp = await stampFile(params.file, params.signal, previous?.stamp);
  let offset = previous?.offset ?? stamp.size;
  let expected = previous ? previous.expected : stamp.replay.tip;
  const branch = previous?.branch ?? stamp.replay.branch;
  let tip = previous?.tip ?? null;
  let partial = false;
  let title: string | undefined;
  let cwd: string | undefined;
  const newest: AgentExternalSessionTranscriptItem[] = [];
  let bytes = 0;
  const page = await readJsonlFileBackwardPage({ filePath: params.file, endOffsetBytes: offset, maxBytes: params.maxSerializedBytes, maxOversizeLineBytes: params.maxSerializedBytes, maxItems: Number.MAX_SAFE_INTEGER, includeMalformedRecords: true });
  if (offset === stamp.size && page.tailOffsetBytes !== null && page.tailOffsetBytes < offset) partial = true;
  partial ||= (page.diagnostics?.length ?? 0) > 0;
  if (offset > 0 && page.nextEndOffsetBytes >= offset) throw new CodeBuddySourceError('source_discontinuity', 'CodeBuddy record exceeds the supplied page allowance.');
  let exhaustedBatch = true;
  for (const line of [...page.items].reverse()) {
    params.signal.throwIfAborted();
    if (newest.length >= params.maxItems || bytes >= params.maxSerializedBytes) { exhaustedBatch = false; break; }
    const value = line.value;
    if (isRecord(value)) {
      if (typeof value.cwd === 'string') cwd ??= value.cwd;
      if (value.type === 'summary' && typeof value.summary === 'string') title ??= value.summary;
      if (value.type === 'ai-title' && typeof value.aiTitle === 'string') title ??= value.aiTitle;
      if (chainTypes.has(String(value.type))) {
        if (branch && (expected === null || value.id !== expected)) { offset = line.startOffsetBytes; continue; }
      }
    }
    const projection = project(value, line.startOffsetBytes);
    const itemBytes = Buffer.byteLength(JSON.stringify(projection.items));
    if (newest.length > 0 && (newest.length + projection.items.length > params.maxItems || bytes + itemBytes > params.maxSerializedBytes)) { exhaustedBatch = false; break; }
    if (itemBytes > params.maxSerializedBytes) throw new CodeBuddySourceError('source_discontinuity', 'CodeBuddy record exceeds the supplied page allowance.');
    newest.push(...projection.items.reverse()); bytes += itemBytes; partial ||= projection.partial;
    tip ??= projection.items.at(-1)?.id ?? null;
    if (branch && isRecord(value) && chainTypes.has(String(value.type)) && typeof value.id === 'string') {
      expected = typeof value.parentId === 'string' ? value.parentId : typeof value.logicalParentId === 'string' ? value.logicalParentId : null;
    }
    offset = line.startOffsetBytes;
  }
  if (exhaustedBatch) offset = page.nextEndOffsetBytes;
  if (offset === 0 && branch && expected !== null) partial = true;
  await stampFile(params.file, params.signal, stamp);
  const state: Cursor = { v: 1, mode: 'page', stamp, offset, expected, branch, tip, pending: false };
  const tailCursor = encodeCursor({ ...state, mode: 'tail', offset: stamp.size, expected: null });
  return { items: newest.reverse(), nextCursor: offset > 0 ? encodeCursor(state) : null, tailCursor, partial, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}) };
}

export async function readAfterCodeBuddyTranscript(params: { file: string; cursor: string; maxItems: number; maxSerializedBytes: number; signal: AbortSignal }) {
  const previous = decodeCursor(params.cursor);
  if (previous.mode !== 'tail') throw new CodeBuddySourceError('invalid_request', 'Expected a CodeBuddy tail cursor.');
  try { await stampFile(params.file, params.signal, previous.stamp); } catch (error) {
    if (error instanceof CodeBuddySourceError) return { outcome: error.code === 'source_unavailable' ? 'source_unavailable' : 'source_replaced' } as const;
    throw error;
  }
  const info = await stat(params.file);
  if (info.size === previous.stamp.size && !previous.pending) return { outcome: 'already_current' } as const;
  const appended: AgentExternalSessionTranscriptItem[] = [];
  let partial = false;
  let cursor: string | undefined;
  let tailCursor = '';
  let found = previous.tip === null;
  do {
    const page = await pageCodeBuddyTranscript({ ...params, cursor });
    partial ||= page.partial;
    tailCursor ||= page.tailCursor;
    const index = page.items.findIndex(item => item.id === previous.tip);
    if (index >= 0) { appended.unshift(...page.items.slice(index + 1)); found = true; break; }
    appended.unshift(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (!found) return { outcome: 'source_replaced' } as const;
  const items: AgentExternalSessionTranscriptItem[] = [];
  let bytes = 0;
  for (const item of appended) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (items.length >= params.maxItems || (items.length > 0 && bytes + size > params.maxSerializedBytes)) break;
    if (size > params.maxSerializedBytes) throw new CodeBuddySourceError('source_discontinuity', 'CodeBuddy record exceeds the supplied page allowance.');
    items.push(item); bytes += size;
  }
  const next = decodeCursor(tailCursor);
  next.tip = items.at(-1)?.id ?? previous.tip;
  next.pending = items.length < appended.length;
  return { outcome: 'advanced', items, nextCursor: encodeCursor(next), boundary: String(next.stamp.size), hasMore: next.pending,
    ...(partial ? { diagnostics: [{ code: 'unsupported_native_record', severity: 'required' as const, count: 1, positions: [] }] } : {}) } as const;
}
