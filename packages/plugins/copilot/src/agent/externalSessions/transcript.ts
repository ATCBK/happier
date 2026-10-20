import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { isRecord, parseTimestampMs } from '@happier-dev/plugin-sdk';
import { createExternalSessionUnsupportedTranscriptItem, readJsonlFileBackwardPage, readJsonlFileForward } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionTranscriptItem, AgentExternalSessionsInvocation, AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsReadAfterTranscriptRequest, AgentExternalSessionsReadAfterTranscriptResult, AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';

// Copilot event schema v1: official SDK 374b77380700e550a39847445656369412f4005f,
// generated/session-events.ts. Compaction changes model context, not the visible
// historical timeline; persisted snapshot rewind physically rewrites events.jsonl.
const BOOKKEEPING = new Set([
  'session.start', 'session.resume', 'session.shutdown', 'session.info', 'session.error', 'session.warning', 'session.idle',
  'session.title_changed', 'session.model_change', 'session.mode_changed', 'session.plan_changed', 'session.handoff',
  'session.compaction_start', 'session.compaction_complete', 'session.truncation', 'session.context_changed', 'session.usage_info',
  'session.usage_checkpoint', 'session.usage_record', 'session.task_complete', 'session.context_cleared',
  'system.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.usage', 'assistant.intent',
  'assistant.reasoning', 'assistant.reasoning_delta', 'assistant.message_delta', 'assistant.message_start',
  'tool.execution_start', 'tool.execution_partial_result', 'tool.execution_progress', 'tool.user_requested',
  'hook.start', 'hook.end', 'permission.requested', 'permission.completed', 'abort',
  'subagent.started', 'subagent.completed', 'subagent.failed', 'subagent.configured', 'subagent.selected',
]);

type Snapshot = Readonly<{ v: 1; session: string; identity: string; size: number; modified: string; digest: string; offset: number; tail: number; supported: boolean }>;
export function encodeCopilotCursor(value: Snapshot): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(raw: string): Snapshot {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString()); }
  catch { throw new Error('invalid_request'); }
  if (!isRecord(value) || value.v !== 1 || typeof value.session !== 'string' || typeof value.identity !== 'string'
    || typeof value.modified !== 'string' || typeof value.digest !== 'string' || typeof value.supported !== 'boolean'
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0
    || typeof value.tail !== 'number' || !Number.isSafeInteger(value.tail) || value.tail < 0 || value.tail > value.size
    || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > value.size) throw new Error('invalid_request');
  return { v: 1, session: value.session, identity: value.identity, modified: value.modified, digest: value.digest,
    size: value.size, offset: value.offset, tail: value.tail, supported: value.supported };
}
async function prefixDigest(file: string, size: number, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  if (size) {
    const stream = createReadStream(file, { start: 0, end: size - 1, signal });
    try { for await (const bytes of stream) { signal.throwIfAborted(); hash.update(bytes); } }
    finally { stream.destroy(); }
  }
  return hash.digest('base64url');
}
function scannerFs(signal: AbortSignal, size: number) {
  return {
    async stat() { signal.throwIfAborted(); return { size, mtimeMs: 0 }; },
    async read(file: string, offset: number, length: number) {
      signal.throwIfAborted();
      const handle = await open(file, 'r');
      try { const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, offset); signal.throwIfAborted(); return buffer.subarray(0, result.bytesRead); }
      finally { await handle.close(); }
    },
  };
}
export async function readCopilotHeader(file: string, session: string, signal: AbortSignal, size?: number) {
  const fileSize = size ?? Number((await stat(file)).size);
  const page = await readJsonlFileForward({ filePath: file, offsetBytes: 0, maxItems: 1,
    maxBytes: Math.max(1, fileSize), fileSystem: scannerFs(signal, fileSize), includeMalformedRecords: true });
  const header = page.items[0]?.value;
  const data = isRecord(header) && isRecord(header.data) ? header.data : null;
  return { supported: isRecord(header) && header.type === 'session.start' && data?.version === 1 && data.sessionId === session,
    ...(isRecord(data?.context) && typeof data.context.cwd === 'string' ? { cwd: data.context.cwd } : {}) };
}
export async function readCopilotSnapshot(file: string, session: string, invocation: AgentExternalSessionsInvocation, cursor?: string) {
  invocation.signal.throwIfAborted();
  const metadata = await stat(file, { bigint: true });
  const identity = `${file}:${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`;
  const size = Number(metadata.size);
  const modified = `${metadata.mtimeNs}:${metadata.ctimeNs}`;
  if (cursor) {
    const value = decodeCursor(cursor);
    if (value.session !== session || value.identity !== identity || value.size > size) throw new Error('source_replaced');
    if (value.modified !== modified && await prefixDigest(file, value.size, invocation.signal) !== value.digest) throw new Error('source_replaced');
    return value;
  }
  const { supported } = await readCopilotHeader(file, session, invocation.signal, size);
  return { v: 1 as const, session, identity, size, modified, digest: await prefixDigest(file, size, invocation.signal), offset: size, tail: size, supported };
}

export function projectCopilotEvent(value: unknown, offset: number, supported: boolean): AgentExternalSessionTranscriptItem | null {
  const record = isRecord(value) ? value : null;
  const id = typeof record?.id === 'string' && record.id ? record.id : `event:${offset}`;
  const createdAtMs = parseTimestampMs(record?.timestamp) ?? 0;
  const unsupported = () => createExternalSessionUnsupportedTranscriptItem({ agentId: 'copilot', id, createdAtMs });
  if (!supported || !record || typeof record.type !== 'string' || !isRecord(record.data)) return unsupported();
  // Ephemeral deltas and child agent events are not a second copy of root text.
  if (record.ephemeral === true || typeof record.agentId === 'string') return null;
  const data = record.data;
  if (record.type === 'user.message' || record.type === 'assistant.message') {
    if (typeof data.content !== 'string') return unsupported();
    if (!data.content.trim()) return null;
    const user = record.type === 'user.message';
    return { id, localId: id, createdAtMs, messageRole: user ? 'user' : 'agent', raw: user
      ? { role: 'user', content: { type: 'text', text: data.content } }
      : { role: 'agent', content: { type: 'acp', agentId: 'copilot', data: { type: 'message', message: data.content } } } };
  }
  if (record.type === 'tool.execution_complete') {
    const result = isRecord(data.result) ? data.result : null;
    const error = isRecord(data.error) ? data.error : null;
    const output = typeof result?.detailedContent === 'string' ? result.detailedContent
      : typeof result?.content === 'string' ? result.content : typeof error?.message === 'string' ? error.message : null;
    if (output === null || typeof data.toolCallId !== 'string') return unsupported();
    return { id, localId: id, createdAtMs, messageRole: 'event', raw: { role: 'agent', content: { type: 'acp', agentId: 'copilot', data: {
      type: 'tool-result', callId: data.toolCallId, output, ...(data.success === false ? { isError: true } : {}),
    } } } };
  }
  return BOOKKEEPING.has(record.type) ? null : unsupported();
}

export function copilotItemText(item: AgentExternalSessionTranscriptItem): string | null {
  if (item.raw.role === 'user') return item.raw.content.text;
  const content = item.raw.content;
  if (!isRecord(content) || !isRecord(content.data)) return null;
  return content.data.type === 'message' && typeof content.data.message === 'string' ? content.data.message
    : content.data.type === 'tool-result' && typeof content.data.output === 'string' ? content.data.output : null;
}
export function isCopilotUnsupported(item: AgentExternalSessionTranscriptItem): boolean {
  return item.localId === null;
}

export async function pageCopilotTranscript(file: string, request: AgentExternalSessionsPageTranscriptRequest): Promise<AgentExternalSessionsTranscriptPage> {
  const snapshot = await readCopilotSnapshot(file, request.remoteSessionId, request, request.cursor);
  const page = request.direction === 'older'
    ? await readJsonlFileBackwardPage({ filePath: file, endOffsetBytes: snapshot.offset, maxItems: request.maxItems,
      maxBytes: request.maxSerializedBytes, fileSystem: scannerFs(request.signal, snapshot.size), includeMalformedRecords: true })
    : null;
  const forward = page ? null : await readJsonlFileForward({ filePath: file, offsetBytes: request.cursor ? snapshot.offset : 0,
    maxItems: request.maxItems, maxBytes: request.maxSerializedBytes, fileSystem: scannerFs(request.signal, snapshot.size), includeMalformedRecords: true });
  const lines = page?.items ?? forward!.items;
  const items = lines.flatMap(line => { const item = projectCopilotEvent(line.value, line.startOffsetBytes, snapshot.supported); return item ? [item] : []; });
  const offset = page?.nextEndOffsetBytes ?? forward!.nextOffsetBytes;
  const stalled = forward !== null && !forward.reachedEnd && offset === (request.cursor ? snapshot.offset : 0);
  const hasMore = page ? !page.reachedStart : !forward!.reachedEnd && !stalled;
  const tornTail = page?.tailOffsetBytes !== null && page?.tailOffsetBytes !== undefined && page.tailOffsetBytes < snapshot.offset;
  const partial = !snapshot.supported || stalled || tornTail || items.some(isCopilotUnsupported) || Boolean(page?.diagnostics?.length || forward?.diagnostics?.length);
  const tail = request.direction === 'older'
    ? request.cursor ? snapshot.tail : page?.tailOffsetBytes ?? snapshot.tail
    : forward!.nextOffsetBytes;
  await readCopilotSnapshot(file, request.remoteSessionId, request, encodeCopilotCursor(snapshot));
  return { items, nextCursor: hasMore ? encodeCopilotCursor({ ...snapshot, offset, tail }) : null,
    tailCursor: encodeCopilotCursor({ ...snapshot, offset: tail, tail }), hasMore,
    ...(partial ? { diagnostics: [{ code: 'unsupported_content', severity: 'required' as const, count: 1, positions: [] }] } : {}) };
}

export async function readAfterCopilotTranscript(file: string, request: AgentExternalSessionsReadAfterTranscriptRequest): Promise<AgentExternalSessionsReadAfterTranscriptResult> {
  const previous = await readCopilotSnapshot(file, request.remoteSessionId, request, request.cursor);
  // Cursor verification already compared the captured prefix. An unchanged
  // tail needs no transcript read/hash, which keeps repeated worker ticks cheap.
  if (Number((await stat(file)).size) === previous.offset) return { outcome: 'already_current' as const };
  const current = await readCopilotSnapshot(file, request.remoteSessionId, request);
  if (previous.offset === current.size) return { outcome: 'already_current' as const };
  const page = await readJsonlFileForward({ filePath: file, offsetBytes: previous.offset, maxItems: request.maxItems,
    maxBytes: request.maxSerializedBytes, fileSystem: scannerFs(request.signal, current.size), includeMalformedRecords: true });
  const items = page.items.flatMap(line => { const item = projectCopilotEvent(line.value, line.startOffsetBytes, current.supported); return item ? [item] : []; });
  const stalled = !page.reachedEnd && page.nextOffsetBytes === previous.offset;
  await readCopilotSnapshot(file, request.remoteSessionId, request, encodeCopilotCursor(current));
  return { outcome: 'advanced' as const, items, nextCursor: encodeCopilotCursor({ ...current, offset: page.nextOffsetBytes }),
    boundary: current.identity, hasMore: !page.reachedEnd && !stalled,
    ...(stalled || items.some(isCopilotUnsupported) || page.diagnostics?.length ? { diagnostics: [{ code: 'unsupported_content', severity: 'required' as const, count: 1, positions: [] }] } : {}) };
}
