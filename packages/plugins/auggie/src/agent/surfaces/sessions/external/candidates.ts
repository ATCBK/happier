import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult } from '@happier-dev/plugin-sdk/sessions/external';
import { isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent,
  type ExternalSessionContentSearchPageProgress } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { AuggieSourceError, decode, encode, fingerprint, readSession, record, sessionIds, type AuggieStore } from './source.js';
import { auggieSearchText, projectAuggieTranscript } from './transcript.js';

type Scan = { source: string; query: string; target: string; threads: boolean; after: string; partial: boolean;
  pending?: { id: string; revision: string; progress: ExternalSessionContentSearchPageProgress } };
function parseScan(cursor: string, base: Pick<Scan, 'source' | 'query' | 'target' | 'threads'>): Scan {
  const v = decode(cursor);
  if (!v || v.source !== base.source || v.query !== base.query || v.target !== base.target || v.threads !== base.threads
    || typeof v.after !== 'string' || typeof v.partial !== 'boolean') throw new AuggieSourceError('source_invalid');
  const result: Scan = { ...base, after: v.after, partial: v.partial };
  if (v.pending !== undefined) {
    const p = v.pending;
    if (!record(p) || typeof p.id !== 'string' || typeof p.revision !== 'string' || !record(p.progress)) throw new AuggieSourceError('source_invalid');
    const g = p.progress;
    if (typeof g.complete !== 'boolean' || !Number.isSafeInteger(g.itemCount) || Number(g.itemCount) < 0
      || (g.cursor !== undefined && (typeof g.cursor !== 'string' || !/^\d+$/u.test(g.cursor)))
      || (g.match !== null && (!record(g.match) || typeof g.match.id !== 'string'
        || !Number.isSafeInteger(g.match.distanceFromEnd) || Number(g.match.distanceFromEnd) < 0
        || (g.match.cursor !== undefined && (typeof g.match.cursor !== 'string' || !/^\d+$/u.test(g.match.cursor)))))) throw new AuggieSourceError('source_invalid');
    result.pending = { id: p.id, revision: p.revision, progress: { complete: g.complete, itemCount: Number(g.itemCount),
      ...(typeof g.cursor === 'string' ? { cursor: g.cursor } : {}), match: record(g.match)
        ? { id: String(g.match.id), distanceFromEnd: Number(g.match.distanceFromEnd), ...(typeof g.match.cursor === 'string' ? { cursor: g.match.cursor } : {}) } : null } };
  }
  return result;
}
export async function listAuggieCandidates(store: AuggieStore, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsListCandidatesResult> {
  const base = { source: fingerprint(store.root), query: request.searchTerm ?? '', target: request.searchTarget ?? 'metadata', threads: request.includeThreads === true };
  const scan: Scan = request.cursor ? parseScan(request.cursor, base) : { ...base, after: '', partial: false };
  const ids = await sessionIds(store, request.signal); const candidates: AgentExternalSessionCandidate[] = [];
  if (scan.pending && !ids.includes(scan.pending.id)) throw new AuggieSourceError('source_invalid');
  const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  let nextCursor: string | null = null;
  for (const id of ids) {
    if (scan.pending ? id < scan.pending.id : id <= scan.after) continue;
    request.signal.throwIfAborted();
    let session;
    try { session = await readSession(store, id, request.signal); }
    catch (error) {
      if (!(error instanceof AuggieSourceError && error.code === 'unsupported')) throw error;
      scan.partial = true; scan.after = id; delete scan.pending; continue;
    }
    if (session.parentId && !base.threads) { scan.after = id; delete scan.pending; continue; }
    const projection = projectAuggieTranscript(session, request.signal);
    let candidate: AgentExternalSessionCandidate = { remoteSessionId: id, createdAtMs: session.createdAtMs, updatedAtMs: session.updatedAtMs,
      messageCount: projection.items.length, ...(session.title ? { title: session.title } : {}), ...(projection.cwd ? { cwd: projection.cwd } : {}),
      ...(session.parentId ? { thread: { kind: 'subagent', parentRemoteSessionId: session.parentId } } : {}) };
    if (base.target === 'content') {
      const revision = fingerprint(session);
      if (scan.pending && (scan.pending.id !== id || scan.pending.revision !== revision)) throw new AuggieSourceError('source_invalid');
      const progress = scan.pending?.progress ?? { complete: false, itemCount: 0, match: null };
      scan.pending = { id, revision, progress };
      try {
        const result = await searchExternalSessionContent({ query: base.query, control, pageProgress: progress,
          decode: async (match, cursor) => {
            const end = cursor === undefined ? projection.items.length : Number(cursor);
            if (!Number.isSafeInteger(end) || end < 0 || end > projection.items.length) throw new AuggieSourceError('source_invalid');
            const item = projection.items[end - 1];
            if (!item) return { records: [], partial: false };
            const body = projection.unsupportedIds.has(item.id) ? null : auggieSearchText(item); const snippet = body === null ? null : match(body);
            return { records: [{ id: item.id, ...(snippet !== null ? { snippet } : {}) }], partial: false,
              nextCursor: end > 1 ? String(end - 1) : null };
          } });
        if (fingerprint(await readSession(store, id, request.signal)) !== revision) throw new AuggieSourceError('source_invalid');
        scan.partial ||= result.partial || projection.partial;
        if (!result.match) { scan.after = id; delete scan.pending; continue; }
        candidate = { ...candidate, match: result.match };
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        nextCursor = encode(scan); break;
      }
    } else if (base.query && !`${session.title ?? ''}\n${projection.cwd ?? ''}\n${id}`.toLowerCase().includes(base.query.toLowerCase())) {
      scan.after = id; delete scan.pending; continue;
    }
    const proposed = { candidates: [...candidates, candidate], nextCursor: encode(scan), contentCoverage: 'partial' };
    if (!isAgentExternalSessionsResultWithinByteBudget({ ok: true, value: proposed }, request.maxSerializedBytes)) {
      if (candidates.length === 0) throw new AuggieSourceError('agent_error');
      nextCursor = encode(scan); break;
    }
    candidates.push(candidate); scan.after = id; delete scan.pending;
    if (candidates.length >= request.maxItems) { if (ids.some(next => next > id)) nextCursor = encode(scan); break; }
  }
  return { candidates, nextCursor, ...(base.target === 'content' ? { contentCoverage: scan.partial || nextCursor ? 'partial' : 'complete' } : {}),
    ...(scan.partial || nextCursor ? { searchIncomplete: true } : {}) };
}
