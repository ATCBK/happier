import { createExternalSessionContentSearchControl, searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult } from '@happier-dev/plugin-sdk/sessions/external';

import { FxSourceError, isFxRecord, listFxSessionIds, readFxMetadata } from './source.js';
import { fxPrefix, readFxTranscript } from './transcript.js';

type NativeProgress = Readonly<{ id: string; throughSeq: number; count: number; identity: string; prefix: string; reported: boolean }>;

function readNativeProgress(value: unknown): NativeProgress {
  if (!isFxRecord(value) || typeof value.id !== 'string' || typeof value.identity !== 'string' || typeof value.prefix !== 'string'
    || typeof value.reported !== 'boolean' || typeof value.throughSeq !== 'number' || !Number.isSafeInteger(value.throughSeq) || value.throughSeq < 1
    || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0) throw new FxSourceError('invalid_request');
  return { id: value.id, identity: value.identity, prefix: value.prefix, reported: value.reported, throughSeq: value.throughSeq, count: value.count };
}

export async function listFxCandidates(root: string, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsListCandidatesResult> {
  const query = request.searchTerm ?? '';
  const target = request.searchTarget ?? 'metadata';
  const includeThreads = request.includeThreads === true;
  let after = '';
  let active: NativeProgress | null = null;
  if (request.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString()); } catch { throw new FxSourceError('invalid_request'); }
    if (!isFxRecord(cursor) || cursor.v !== 1 || cursor.root !== root || cursor.query !== query
      || cursor.target !== target || cursor.includeThreads !== includeThreads || typeof cursor.after !== 'string') {
      throw new FxSourceError('invalid_request');
    }
    after = cursor.after;
    if (cursor.active !== undefined) active = readNativeProgress(cursor.active);
  }
  const cursorFor = (after: string, active?: NativeProgress) => Buffer.from(JSON.stringify({ v: 1,
    root, query, target, includeThreads, after, ...(active ? { active } : {}) })).toString('base64url');
  const inventory = await listFxSessionIds(root, request.signal);
  const ids = inventory.ids.filter(id => id > after);
  if (active && !ids.includes(active.id)) throw new FxSourceError('source_invalid');
  const candidates: AgentExternalSessionCandidate[] = [];
  let partial = inventory.unsupported;
  let nextCursor: string | null = null;
  const deadline = request.scanDeadlineAtMs ?? request.deadlineAtMs;
  for (let index = 0; index < ids.length; index++) {
    request.signal.throwIfAborted();
    const id = ids[index]!;
    try {
      const metadata = await readFxMetadata(root, id);
      if (!metadata.child || request.includeThreads) {
        const candidate: AgentExternalSessionCandidate = { remoteSessionId: id,
          ...(metadata.title ? { title: metadata.title } : {}), cwd: metadata.cwd,
          createdAtMs: metadata.createdAtMs, updatedAtMs: metadata.updatedAtMs,
          ...(metadata.child ? { thread: { kind: 'subagent', parentRemoteSessionId: null } } : {}) };
        if (target === 'content') {
          const prior = active;
          if (prior && prior.id !== id) throw new FxSourceError('source_invalid');
          const projection = await readFxTranscript(root, id, request.signal, {
            deadlineAtMs: deadline, ...(prior ? { resumeAfterSeq: prior.throughSeq } : {}) });
          if (prior && (prior.identity !== projection.identity || prior.count > projection.items.length
            || prior.prefix !== fxPrefix(projection.items, prior.count))) throw new FxSourceError('source_invalid');
          const found = await searchExternalSessionContent({ query,
            control: createExternalSessionContentSearchControl({ signal: request.signal }),
            isScanComplete: () => true,
            decode: async matchText => ({ partial: projection.partial,
              records: projection.items.map(row => {
                const snippet = row.text === undefined ? null : matchText(row.text);
                return { id: row.item.id, ...(snippet === null ? {} : { snippet }) };
              }) }),
          });
          partial ||= found.partial;
          if (found.match && !prior?.reported) candidates.push({ ...candidate, match: found.match,
            ...(!projection.partial && projection.complete ? { messageCount: projection.items.length } : {}) });
          if (!projection.complete) {
            active = { id, identity: projection.identity, prefix: fxPrefix(projection.items, projection.items.length),
              count: projection.items.length, throughSeq: projection.throughSeq, reported: prior?.reported === true || found.match !== undefined };
            nextCursor = cursorFor(after, active);
            break;
          }
          active = null;
        } else if (!query || `${metadata.title ?? ''}\n${metadata.cwd}\n${id}`.toLowerCase().includes(query.toLowerCase())) {
          candidates.push(candidate);
        }
      }
    } catch (error) {
      request.signal.throwIfAborted();
      if (!(error instanceof FxSourceError) || error.code !== 'unsupported') throw error;
      partial = true;
    }
    if (Buffer.byteLength(JSON.stringify({ ok: true, value: { candidates, nextCursor: null } })) > request.maxSerializedBytes) {
      throw new FxSourceError('agent_error');
    }
    after = id;
    if (index < ids.length - 1 && (candidates.length >= request.maxItems || (deadline !== undefined && Date.now() >= deadline))) {
      nextCursor = cursorFor(after);
      break;
    }
  }
  return { candidates, nextCursor, searchIncomplete: partial || nextCursor !== null,
    ...(target === 'content' ? { contentCoverage: partial || nextCursor ? 'partial' : 'complete' } : {}) };
}
