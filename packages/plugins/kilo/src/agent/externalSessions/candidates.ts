import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult } from '@happier-dev/plugin-sdk/sessions/external';
import { isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent,
  type ExternalSessionContentSearchPageProgress } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { messageIds, readMessage, searchText } from './messages.js';
import { children, confinedPath, decode, encode, fingerprint, isId, KiloStoreError, readSession, record, sessionPaths, type KiloSession, type KiloStore } from './source.js';

type Scan = { v: 1; source: string; query: string; target: string; threads: boolean; after: string; incomplete: boolean;
  pending?: { path: string; revision: string; progress: ExternalSessionContentSearchPageProgress } };

/** Parts settle independently of Session.time.updated. Check all native part
 * dependencies, within this operation only; no cross-request metadata cache. */
async function revision(store: KiloStore, session: KiloSession, ids: readonly string[], signal: AbortSignal): Promise<string> {
  const facts: unknown[] = [];
  const add = async (path: string) => {
    signal.throwIfAborted(); const s = await stat(await confinedPath(store, path));
    facts.push([relative(store.root, path), s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
  };
  await add(session.path);
  for (const id of ids) {
    await add(join(store.root, 'message', session.id, `${id}.json`));
    const directory = join(store.root, 'part', id);
    try {
      for (const name of await children(store, directory)) if (name.endsWith('.json') && isId(name.slice(0, -5))) await add(join(directory, name));
    } catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; facts.push([id, 'missing_parts']); }
  }
  return fingerprint(facts);
}
function parseScan(raw: string, base: Omit<Scan, 'after' | 'incomplete'>): Scan {
  const value = decode(raw);
  if (!value || value.v !== 1 || value.source !== base.source || value.query !== base.query || value.target !== base.target
    || value.threads !== base.threads || typeof value.after !== 'string' || typeof value.incomplete !== 'boolean') throw new KiloStoreError('source_invalid');
  if (value.pending !== undefined) {
    const p = value.pending;
    if (!record(p) || typeof p.path !== 'string' || typeof p.revision !== 'string' || !record(p.progress)
      || typeof p.progress.complete !== 'boolean' || !Number.isSafeInteger(p.progress.itemCount) || Number(p.progress.itemCount) < 0
      || (p.progress.cursor !== undefined && (typeof p.progress.cursor !== 'string' || !/^\d+$/u.test(p.progress.cursor)))
      || (p.progress.match !== null && (!record(p.progress.match) || typeof p.progress.match.id !== 'string'
        || !Number.isSafeInteger(p.progress.match.distanceFromEnd) || Number(p.progress.match.distanceFromEnd) < 0
        || (p.progress.match.cursor !== undefined && (typeof p.progress.match.cursor !== 'string' || !/^\d+$/u.test(p.progress.match.cursor)))))) {
      throw new KiloStoreError('source_invalid');
    }
    return { ...base, after: value.after, incomplete: value.incomplete, pending: { path: p.path, revision: p.revision,
      progress: { complete: p.progress.complete, itemCount: Number(p.progress.itemCount),
        ...(typeof p.progress.cursor === 'string' ? { cursor: p.progress.cursor } : {}),
        match: record(p.progress.match) ? { id: String(p.progress.match.id), distanceFromEnd: Number(p.progress.match.distanceFromEnd),
          ...(typeof p.progress.match.cursor === 'string' ? { cursor: p.progress.match.cursor } : {}) } : null } } };
  }
  return { ...base, after: value.after, incomplete: value.incomplete };
}

export async function listKiloCandidates(store: KiloStore, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsListCandidatesResult> {
  const query = request.searchTerm ?? '';
  const target = request.searchTarget ?? 'metadata';
  const base = { v: 1 as const, source: fingerprint(store.root), query, target, threads: request.includeThreads === true };
  const scan: Scan = request.cursor ? parseScan(request.cursor, base) : { ...base, after: '', incomplete: false };
  const paths = await sessionPaths(store, request.signal);
  const candidates: AgentExternalSessionCandidate[] = [];
  let partial = scan.incomplete;
  if (scan.pending && !paths.some(path => relative(store.root, path) === scan.pending!.path)) throw new KiloStoreError('source_invalid');
  let nextCursor: string | null = null;
  const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  for (const path of paths) {
    const key = relative(store.root, path);
    if (scan.pending ? key < scan.pending.path : key <= scan.after) continue;
    request.signal.throwIfAborted();
    const session = await readSession(store, path, request.signal);
    if (session.parentID && !request.includeThreads) { scan.after = key; continue; }
    let candidate: AgentExternalSessionCandidate = { remoteSessionId: session.id, updatedAtMs: session.updatedAtMs,
      createdAtMs: session.createdAtMs, archived: session.archived,
      ...(session.title ? { title: session.title } : {}), ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.parentID ? { thread: { kind: 'subagent', parentRemoteSessionId: session.parentID } } : {}) };
    if (target === 'content') {
      if (session.version !== '1.0.25') { partial = true; scan.incomplete = true; scan.after = key; delete scan.pending; continue; }
      const ids = await messageIds(store, session);
      const stamp = await revision(store, session, ids, request.signal);
      if (scan.pending && (scan.pending.path !== key || scan.pending.revision !== stamp)) throw new KiloStoreError('source_invalid');
      const progress = scan.pending?.progress ?? { complete: false, itemCount: 0, match: null };
      scan.pending = { path: key, revision: stamp, progress };
      try {
        const result = await searchExternalSessionContent({ query, control, pageProgress: progress,
          decode: async (matchText, cursor) => {
            const end = cursor === undefined ? ids.length : Number(cursor);
            if (!Number.isSafeInteger(end) || end < 0 || end > ids.length) throw new KiloStoreError('source_invalid');
            if (end === 0) return { records: [], partial: false };
            const projection = await readMessage(store, session, ids[end - 1]!, request.signal);
            return { records: projection.items.map(item => {
              const text = searchText(item); const snippet = text === null ? null : matchText(text);
              return { id: item.id, ...(snippet !== null ? { snippet } : {}) };
            }), partial: projection.partial, nextCursor: end > 1 ? String(end - 1) : null };
          } });
        if (await revision(store, session, ids, request.signal) !== stamp) throw new KiloStoreError('source_invalid');
        partial ||= result.partial;
        scan.incomplete ||= result.partial;
        if (result.match) candidate = { ...candidate, match: result.match, messageCount: progress.itemCount };
        else { scan.after = key; delete scan.pending; continue; }
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        partial = true; nextCursor = encode(scan); break;
      }
    } else if (query && !`${session.title ?? ''}\n${session.cwd ?? ''}\n${session.id}`.toLowerCase().includes(query.toLowerCase())) {
      scan.after = key; continue;
    }
    const proposed = { candidates: [...candidates, candidate], nextCursor: encode(scan), contentCoverage: 'partial' };
    if (!isAgentExternalSessionsResultWithinByteBudget({ ok: true, value: proposed }, request.maxSerializedBytes)) {
      if (!candidates.length) throw new KiloStoreError('agent_error');
      nextCursor = encode(scan); break;
    }
    candidates.push(candidate); scan.after = key; delete scan.pending;
    if (candidates.length >= request.maxItems) {
      if (paths.some(p => relative(store.root, p) > key)) nextCursor = encode(scan);
      break;
    }
  }
  return { candidates, nextCursor, ...(target === 'content' ? { contentCoverage: partial || nextCursor ? 'partial' : 'complete' } : {}),
    ...(partial || nextCursor ? { searchIncomplete: true } : {}) };
}
