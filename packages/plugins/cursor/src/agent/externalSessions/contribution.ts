import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type {
  AgentExternalSessionsContribution, AgentExternalSessionsInvocation, AgentExternalSessionsResult,
  AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { readJsonlFileBackwardPage, readJsonlFileForward } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { discoverCursorNativeFiles, readCursorMetadata, resolveCursorNativeSource, type CursorNativeSource } from './source.js';
import { cursorFileWitness, decodeCursorNativeRecord, decodeTranscriptCursor, encodeCursor, type CursorFileWitness } from './transcript.js';
import { listCursorNativeCandidates } from './candidates.js';

const ok = <T>(value: T): AgentExternalSessionsResult<T> => ({ ok: true, value });
async function run<T>(request: AgentExternalSessionsInvocation, work: () => Promise<AgentExternalSessionsResult<T>>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request);
  if (stopped) return stopped;
  try { return await work(); }
  catch {
    const cancelled = getAgentExternalSessionsInvocationFailure(request);
    if (cancelled) return cancelled;
    return { ok: false, code: 'agent_unavailable', retryable: true };
  }
}
async function findFile(root: CursorNativeSource, id: string, signal: AbortSignal) {
  const matches = (await discoverCursorNativeFiles(root, signal)).files.filter(file => file.id === id);
  // An ambiguous native identity cannot select an arbitrary project transcript.
  return matches.length === 1 ? matches[0]! : null;
}
function samePrefix(a: CursorFileWitness, b: CursorFileWitness) { return a.identity === b.identity && a.size === b.size && a.prefix === b.prefix; }

async function page(root: CursorNativeSource, request: AgentExternalSessionsPageTranscriptRequest): Promise<AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>> {
  const file = await findFile(root, request.remoteSessionId, request.signal);
  if (!file) return { ok: false, code: 'candidate_not_found' };
  const metadata = await readCursorMetadata(file);
  if (!metadata.supported) return { ok: false, code: 'unsupported' };
  const previous = request.cursor ? decodeTranscriptCursor(request.cursor) : null;
  if (request.cursor && (!previous || previous.homeDir !== root.homeDir || previous.id !== file.id)) return { ok: false, code: 'invalid_request' };
  let witness = await cursorFileWitness(file.path, previous?.witness.size, request.signal, previous?.witness);
  if (previous && !samePrefix(previous.witness, witness)) return { ok: false, code: 'source_invalid' };
  const info = await lstat(file.path);
  if (request.direction === 'newer' && info.size !== witness.size) witness = await cursorFileWitness(file.path, undefined, request.signal);
  const cursor = (position: number, captured = witness) => encodeCursor({ v: 1, kind: 'cursorTranscript', homeDir: root.homeDir, id: file.id, position, witness: captured });
  const raw = request.direction === 'older'
    ? await readJsonlFileBackwardPage({ filePath: file.path, endOffsetBytes: previous?.position ?? witness.size,
      maxBytes: request.maxSerializedBytes, maxItems: request.maxItems, maxOversizeLineBytes: witness.size, includeMalformedRecords: true })
    : await readJsonlFileForward({ filePath: file.path, offsetBytes: previous?.position ?? 0,
      maxBytes: request.maxSerializedBytes, maxItems: request.maxItems, maxOversizeLineBytes: info.size, includeMalformedRecords: true });
  request.signal.throwIfAborted();
  if (!samePrefix(witness, await cursorFileWitness(file.path, witness.size, request.signal, witness))) return { ok: false, code: 'source_invalid' };
  const projected = raw.items.map(line => decodeCursorNativeRecord(line.value, line.startOffsetBytes, metadata.createdAtMs ?? info.mtimeMs));
  const items = projected.map(record => record.item);
  const older = 'nextEndOffsetBytes' in raw;
  const nextPosition = older ? raw.nextEndOffsetBytes : raw.nextOffsetBytes;
  const hasMore = older ? !raw.reachedStart : !raw.reachedEnd;
  const tailPosition = older ? raw.tailOffsetBytes ?? witness.size : nextPosition;
  const incompleteTail = older && tailPosition < witness.size;
  const tailWitness = tailPosition === witness.size ? witness : await cursorFileWitness(file.path, tailPosition, request.signal);
  const result = ok({ items, nextCursor: hasMore ? cursor(nextPosition) : null,
    tailCursor: cursor(tailPosition, tailWitness), hasMore,
    ...(projected.some(record => record.partial) || raw.diagnostics?.length || incompleteTail ? { diagnostics: [{ code: 'unsupported_native_record', severity: 'required' as const,
      count: projected.filter(record => record.partial).length + (raw.diagnostics?.length ?? 0) + (incompleteTail ? 1 : 0), positions: [] }] } : {}),
  });
  if (!isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)) {
    if (request.maxItems > 1) return page(root, { ...request, maxItems: Math.max(1, Math.floor(request.maxItems / 2)) });
    return createAgentExternalSessionsProducerOverflowFailure('Cursor transcript record exceeds the caller result budget.');
  }
  return result;
}

type ReadAfterTranscriptValue = Awaited<ReturnType<AgentExternalSessionsContribution['readAfterTranscript']>> extends AgentExternalSessionsResult<infer V> ? V : never;

export const cursorExternalSessionsContribution: AgentExternalSessionsContribution = {
  resolveSource(request) { return run(request, async () => {
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    if (request.includeAccountingSource === false) return ok({ source: root.source });
    const inventory = await discoverCursorNativeFiles(root, request.signal);
    return ok({ source: root.source, accountingSource: {
      rootPath: root.homeDir, resourceKey: `cursor:transcripts:${createHash('sha256').update(root.homeDir).digest('base64url')}`,
      changeObservation: 'watch_file_changes' as const, watchFileChanges: {
        files: [...inventory.files.map(file => file.path), ...inventory.metadataFiles], topologyDirectories: inventory.directories,
      },
    } });
  }); },
  listCandidates(request) { return run(request, async () => {
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    return listCursorNativeCandidates(root, request);
  }); },
  resolveLinkIdentity(request) { return run(request, async () => {
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return { ok: false, code: 'source_invalid' };
    const file = await findFile(root, request.remoteSessionId, request.signal);
    if (!file) return { ok: false, code: 'candidate_not_found' };
    if (!(await readCursorMetadata(file)).supported) return { ok: false, code: 'unsupported' };
    return ok({ source: root.source, remoteSessionId: file.id, linkData: {} });
  }); },
  resolveLinkedIdentity(request) { return cursorExternalSessionsContribution.resolveLinkIdentity(request); },
  pageTranscript(request) { return run(request, async () => {
    const root = await resolveCursorNativeSource(request.source);
    return root ? page(root, request) : { ok: false, code: 'source_invalid' };
  }); },
  readAfterTranscript(request) { return run<ReadAfterTranscriptValue>(request, async () => {
    const root = await resolveCursorNativeSource(request.source);
    if (!root) return ok({ outcome: 'source_unavailable' as const });
    const previous = decodeTranscriptCursor(request.cursor);
    if (!previous || previous.homeDir !== root.homeDir || previous.id !== request.remoteSessionId) return ok({ outcome: 'gap_or_cursor_expired' as const });
    const file = await findFile(root, request.remoteSessionId, request.signal);
    if (!file) return ok({ outcome: 'source_unavailable' as const });
    const info = await lstat(file.path);
    if (info.size < previous.witness.size) return ok({ outcome: 'source_replaced' as const });
    const witness = await cursorFileWitness(file.path, previous.witness.size, request.signal, previous.witness);
    if (!samePrefix(previous.witness, witness)) return ok({ outcome: 'source_replaced' as const });
    if (info.size === previous.position) return ok({ outcome: 'already_current' as const });
    // The prefix is verified above; the existing decoder pages only appended
    // bytes, and returns a new witness bound to the consumed newline frontier.
    const forward = await page(root, { ...request, direction: 'newer' });
    if (!forward.ok) return forward.code === 'source_invalid' ? ok({ outcome: 'source_replaced' as const }) : forward;
    if (!forward.value.tailCursor) return ok({ outcome: 'read_failed' as const });
    if (decodeTranscriptCursor(forward.value.tailCursor)?.position === previous.position && !forward.value.items.length) return ok({ outcome: 'already_current' as const });
    return ok({ outcome: 'advanced' as const, items: forward.value.items, nextCursor: forward.value.tailCursor,
      boundary: file.id, hasMore: forward.value.hasMore ?? false, diagnostics: forward.value.diagnostics });
  }); },
};
