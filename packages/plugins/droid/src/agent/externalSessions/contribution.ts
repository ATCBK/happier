import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent,
  type ExternalSessionContentSearchPageProgress } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { getAgentExternalSessionsInvocationFailure, createAgentExternalSessionsProducerOverflowFailure,
  type AgentExternalSessionCandidate, type AgentExternalSessionsContribution, type AgentExternalSessionsInvocationBounds,
  type AgentExternalSessionsResult, type AgentExternalSessionsListCandidatesResult, type AgentExternalSessionSource,
  type AgentExternalSessionsTranscriptPage, type AgentExternalSessionsReadAfterTranscriptResult,
} from '@happier-dev/plugin-sdk/sessions/external';
import { authorizeDroidFile, DroidReadError, droidInventory, resolveDroidSource, type DroidSource } from './source.js';
import { decode, digest, encode, index, readDroidTranscript, record, type DroidTranscript } from './transcript.js';

function ok<T>(value: T): AgentExternalSessionsResult<T> { return { ok: true, value }; }
function byteLength(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
async function guard<T>(request: AgentExternalSessionsInvocationBounds, operation: () => Promise<AgentExternalSessionsResult<T>>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request);
  if (stopped) return stopped;
  try {
    const result = await operation();
    return getAgentExternalSessionsInvocationFailure(request) ?? result;
  } catch (error) {
    const cancelled = getAgentExternalSessionsInvocationFailure(request);
    if (cancelled) return cancelled;
    if (error instanceof DroidReadError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'source_unreachable', message: 'Droid native session storage is unreadable.', retryable: true };
  }
}
type SearchCursor = {
  v: 1; root: string; query: string; target: string; after: string; partial: boolean; supported: number; unsupported: number;
  pending?: { file: string; digest: string; progress: ExternalSessionContentSearchPageProgress };
};
function readSearchCursor(raw: string | undefined, root: string, query: string, target: string): SearchCursor {
  const empty: SearchCursor = { v: 1, root, query, target, after: '', partial: false, supported: 0, unsupported: 0 };
  if (!raw) return empty;
  const value = decode(raw);
  if (value.v !== 1 || value.root !== root || value.query !== query || value.target !== target
    || typeof value.after !== 'string' || typeof value.partial !== 'boolean' || !index(value.supported) || !index(value.unsupported)) {
    throw new DroidReadError('invalid_request', 'Droid candidate continuation does not match this query.');
  }
  const cursor: SearchCursor = { ...empty, after: value.after, partial: value.partial, supported: value.supported, unsupported: value.unsupported };
  if (value.pending !== undefined) {
    const pending = value.pending;
    if (!record(pending) || typeof pending.file !== 'string' || typeof pending.digest !== 'string' || !record(pending.progress)) {
      throw new DroidReadError('invalid_request', 'Invalid Droid content continuation.');
    }
    const p = pending.progress;
    if (typeof p.complete !== 'boolean' || !index(p.itemCount) || (p.cursor !== undefined && (typeof p.cursor !== 'string' || !/^\d+$/.test(p.cursor)))
      || (p.match !== null && (!record(p.match) || typeof p.match.id !== 'string' || !index(p.match.distanceFromEnd)
        || p.match.distanceFromEnd < 1 || p.match.distanceFromEnd > p.itemCount
        || (p.match.cursor !== undefined && (typeof p.match.cursor !== 'string' || !/^\d+$/.test(p.match.cursor)))))) {
      throw new DroidReadError('invalid_request', 'Invalid Droid content progress.');
    }
    cursor.pending = { file: pending.file, digest: pending.digest,
      progress: { complete: p.complete, itemCount: p.itemCount, ...(typeof p.cursor === 'string' ? { cursor: p.cursor } : {}),
        match: record(p.match) ? { id: String(p.match.id), distanceFromEnd: Number(p.match.distanceFromEnd),
          ...(typeof p.match.cursor === 'string' ? { cursor: p.match.cursor } : {}) } : null } };
  }
  return cursor;
}
type TranscriptCursor = { v: 1; file: string; session: string; identity: string; size: number; digest: string; count: number; selection: string; position: number; direction: string };
function selection(snapshot: DroidTranscript, count: number): string { return digest(JSON.stringify(snapshot.items.slice(0, count).map(item => item.id))); }
function transcriptCursor(file: string, snapshot: DroidTranscript, position: number, direction: string, count = snapshot.items.length): TranscriptCursor {
  return { v: 1, file, session: snapshot.sessionId, identity: snapshot.identity, size: snapshot.bytes.length,
    digest: snapshot.digest, count, selection: selection(snapshot, count), position, direction };
}
function readTranscriptCursor(raw: string, file: string, snapshot: DroidTranscript): TranscriptCursor {
  const value = decode(raw);
  if (value.v !== 1 || value.file !== file || value.session !== snapshot.sessionId || typeof value.identity !== 'string'
    || !index(value.size) || typeof value.digest !== 'string' || !index(value.count) || typeof value.selection !== 'string'
    || !index(value.position) || typeof value.direction !== 'string') throw new DroidReadError('invalid_request', 'Invalid Droid transcript cursor.');
  return { v: 1, file, session: snapshot.sessionId, identity: value.identity, size: value.size,
    digest: value.digest, count: value.count, selection: value.selection, position: value.position, direction: value.direction };
}
function candidate(snapshot: DroidTranscript, file: string): AgentExternalSessionCandidate {
  return { remoteSessionId: snapshot.sessionId, updatedAtMs: snapshot.updatedAtMs,
    ...(snapshot.createdAtMs === undefined ? {} : { createdAtMs: snapshot.createdAtMs }),
    ...(snapshot.cwd === undefined ? {} : { cwd: snapshot.cwd }),
    ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
    ...(!snapshot.partial ? { messageCount: snapshot.items.length } : {}), linkData: { sessionFilePath: file } };
}
function diagnostics(snapshot: DroidTranscript) {
  return snapshot.partial ? [{ code: 'unsupported_native_record', severity: 'required' as const, count: 1, positions: [] }] : undefined;
}

export function createDroidExternalSessionsContribution(options: { env?: NodeJS.ProcessEnv } = {}): AgentExternalSessionsContribution {
  const sourceFor = (source: AgentExternalSessionSource) => resolveDroidSource(source, options.env ?? process.env);
  async function locate(source: DroidSource, remoteSessionId: string, signal: AbortSignal, supplied?: unknown) {
    if (typeof supplied === 'string') {
      const file = await authorizeDroidFile(source, supplied);
      const snapshot = await readDroidTranscript(file, signal);
      if (snapshot.sessionId !== remoteSessionId) throw new DroidReadError('source_invalid', 'Droid session identity does not match its transcript.');
      return { file, snapshot };
    }
    const inventory = await droidInventory(source, signal);
    for (const path of inventory.files) {
      const file = await authorizeDroidFile(source, path);
      let snapshot: DroidTranscript;
      try { snapshot = await readDroidTranscript(file, signal); }
      catch (error) { if (error instanceof DroidReadError && error.code === 'unsupported') continue; throw error; }
      if (snapshot.sessionId === remoteSessionId) return { file, snapshot };
    }
    throw new DroidReadError('unsupported', 'No supported Droid native transcript matches this session.');
  }
  async function resolveIdentity(request: Parameters<AgentExternalSessionsContribution['resolveLinkIdentity']>[0]) {
    const source = await sourceFor(request.source);
    const { file } = await locate(source, request.remoteSessionId, request.signal, request.linkData?.sessionFilePath ?? request.source.sessionFilePath);
    return ok({ source: { ...source, sessionFilePath: file }, remoteSessionId: request.remoteSessionId, linkData: { sessionFilePath: file } });
  }
  return {
    resolveSource(request) { return guard(request, async () => {
      const source = await sourceFor(request.source);
      if (request.includeAccountingSource === false) return ok({ source });
      const inventory = await droidInventory(source, request.signal);
      return ok({ source, accountingSource: { rootPath: source.factoryDir, rootField: 'factoryDir',
        resourceKey: `droid:transcripts:${digest(source.factoryDir)}`, changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [...inventory.files], topologyDirectories: [...inventory.topologyDirectories] } } });
    }); },
    listCandidates(request) { return guard(request, async () => {
      const source = await sourceFor(request.source);
      const query = request.searchTerm ?? '';
      const target = request.searchTarget ?? 'metadata';
      const cursor = readSearchCursor(request.cursor, source.factoryDir, query, target);
      const inventory = await droidInventory(source, request.signal);
      if (!inventory.available) throw new DroidReadError('source_unreachable', 'Droid native session roots are unavailable.');
      if (cursor.pending && !inventory.files.includes(cursor.pending.file)) throw new DroidReadError('unavailable', 'Droid content source disappeared.');
      const candidates: AgentExternalSessionCandidate[] = [];
      const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
      let hasMore = false;
      const files = inventory.files.filter(file => file > cursor.after);
      for (const [fileIndex, path] of files.entries()) {
        const file = await authorizeDroidFile(source, path);
        let snapshot: DroidTranscript;
        try { snapshot = await readDroidTranscript(file, request.signal); }
        catch (error) {
          if (!(error instanceof DroidReadError) || error.code !== 'unsupported') throw error;
          cursor.unsupported += 1; cursor.partial = true; cursor.after = path;
          continue;
        }
        if (cursor.pending && (cursor.pending.file !== path || cursor.pending.digest !== snapshot.digest)) {
          throw new DroidReadError('unavailable', 'Droid transcript changed during content search.');
        }
        const row = candidate(snapshot, file);
        if (target === 'content' && query) {
          cursor.pending ??= { file: path, digest: snapshot.digest, progress: { complete: false, itemCount: 0, match: null } };
          const progress = cursor.pending.progress;
          try {
            const found = await searchExternalSessionContent({ query, paths: [file], ripgrep: request.ripgrep, control,
              pageProgress: progress, decode: async (matchText, rawCursor) => {
                const end = rawCursor === undefined ? snapshot.items.length : Number(rawCursor);
                if (!index(end) || end > snapshot.items.length) throw new DroidReadError('invalid_request', 'Invalid Droid content position.');
                const item = snapshot.items[end - 1];
                const snippet = item ? matchText(snapshot.texts[end - 1]!) : null;
                return { records: item ? [{ id: item.id, ...(snippet === null ? {} : { snippet }) }] : [], partial: false,
                  nextCursor: end > 1 ? String(end - 1) : null };
              } });
            if (found.match) candidates.push({ ...row, match: found.match });
          } catch (error) {
            if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
            hasMore = true; break;
          }
        } else if (!query || `${row.title ?? ''}\n${row.cwd ?? ''}\n${row.remoteSessionId}`.toLowerCase().includes(query.toLowerCase())) candidates.push(row);
        cursor.pending = undefined; cursor.after = path; cursor.supported += 1; cursor.partial ||= snapshot.partial;
        if (candidates.length >= request.maxItems) { hasMore = fileIndex < files.length - 1; break; }
      }
      const coverage = cursor.supported === 0 && cursor.unsupported > 0 && !hasMore ? 'unsupported'
        : cursor.partial || hasMore ? 'partial' : 'complete';
      const value: AgentExternalSessionsListCandidatesResult = { candidates, nextCursor: hasMore ? encode(cursor) : null,
        searchIncomplete: cursor.partial || hasMore, ...(target === 'content' ? { contentCoverage: coverage } : {}) };
      return byteLength({ ok: true, value }) <= request.maxSerializedBytes ? ok(value) : createAgentExternalSessionsProducerOverflowFailure('Droid candidate result exceeds its caller byte budget.');
    }); },
    resolveLinkIdentity(request) { return guard(request, () => resolveIdentity(request)); },
    resolveLinkedIdentity(request) { return guard(request, () => resolveIdentity(request)); },
    pageTranscript(request) { return guard(request, async () => {
      const source = await sourceFor(request.source);
      const { file, snapshot } = await locate(source, request.remoteSessionId, request.signal, request.source.sessionFilePath);
      const previous = request.cursor ? readTranscriptCursor(request.cursor, file, snapshot) : null;
      if (previous && (previous.identity !== snapshot.identity || previous.digest !== snapshot.digest || previous.direction !== request.direction)) {
        throw new DroidReadError('unavailable', 'Droid transcript changed during paging.');
      }
      const position = previous?.position ?? (request.direction === 'older' ? snapshot.items.length : 0);
      if (position > snapshot.items.length) throw new DroidReadError('invalid_request', 'Droid transcript position is unavailable.');
      let size = Math.min(request.maxItems, request.direction === 'older' ? position : snapshot.items.length - position);
      while (true) {
        const start = request.direction === 'older' ? position - size : position;
        const end = start + size;
        const next = request.direction === 'older' ? start : end;
        const more = request.direction === 'older' ? next > 0 : next < snapshot.items.length;
        const value: AgentExternalSessionsTranscriptPage = { items: snapshot.items.slice(start, end), hasMore: more,
          nextCursor: more ? encode(transcriptCursor(file, snapshot, next, request.direction)) : null,
          tailCursor: encode(transcriptCursor(file, snapshot, snapshot.items.length, 'tail')), diagnostics: diagnostics(snapshot) };
        if (byteLength({ ok: true, value }) <= request.maxSerializedBytes) return ok(value);
        if (size <= 1) return createAgentExternalSessionsProducerOverflowFailure('Droid transcript item exceeds its caller byte budget.');
        size -= 1;
      }
    }); },
    readAfterTranscript(request) { return guard<AgentExternalSessionsReadAfterTranscriptResult>(request, async () => {
      const source = await sourceFor(request.source);
      let located: Awaited<ReturnType<typeof locate>>;
      try { located = await locate(source, request.remoteSessionId, request.signal, request.source.sessionFilePath); }
      catch (error) { if (error instanceof DroidReadError && error.code === 'source_unreachable') return ok({ outcome: 'source_unavailable' as const }); throw error; }
      const { file, snapshot } = located;
      const previous = readTranscriptCursor(request.cursor, file, snapshot);
      if (previous.direction !== 'tail') throw new DroidReadError('invalid_request', 'Droid read-after requires a tail cursor.');
      if (previous.identity !== snapshot.identity || previous.size > snapshot.bytes.length
        || digest(snapshot.bytes.subarray(0, previous.size)) !== previous.digest || previous.count > snapshot.items.length
        || selection(snapshot, previous.count) !== previous.selection) return ok({ outcome: 'source_replaced' as const });
      if (previous.count === snapshot.items.length) return ok({ outcome:
        snapshot.partial && previous.size !== snapshot.bytes.length ? 'read_failed' as const : 'already_current' as const });
      let size = Math.min(request.maxItems, snapshot.items.length - previous.count);
      while (true) {
        const count = previous.count + size;
        const value: AgentExternalSessionsReadAfterTranscriptResult = { outcome: 'advanced', items: snapshot.items.slice(previous.count, count),
          nextCursor: encode(transcriptCursor(file, snapshot, count, 'tail', count)),
          boundary: snapshot.items[count - 1]!.id, hasMore: count < snapshot.items.length, diagnostics: diagnostics(snapshot) };
        if (byteLength({ ok: true, value }) <= request.maxSerializedBytes) return ok(value);
        if (size <= 1) return createAgentExternalSessionsProducerOverflowFailure('Droid transcript item exceeds its caller byte budget.');
        size -= 1;
      }
    }); },
  };
}
export const droidExternalSessionsContribution = createDroidExternalSessionsContribution();
