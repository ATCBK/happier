import { stat } from 'node:fs/promises';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, readJsonlFileForwardLines,
  searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult } from '@happier-dev/plugin-sdk/sessions/external';
import { isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { decode, encode, grokFile, GrokSourceError, listGrokSessions, readGrokSummary, record, type GrokSession } from './source.js';
import { decodeGrokRecord, grokFileSnapshot } from './transcript.js';

type Progress = { snapshot: string; offset: number; count: number; partial: boolean; match: { offset: number; index: number } | null };
function progress(value: unknown): Progress {
  if (!record(value) || typeof value.snapshot !== 'string' || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0
    || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0 || typeof value.partial !== 'boolean'
    || (value.match !== null && (!record(value.match) || typeof value.match.offset !== 'number' || !Number.isSafeInteger(value.match.offset)
      || value.match.offset < 0 || value.match.offset >= value.offset || typeof value.match.index !== 'number'
      || !Number.isSafeInteger(value.match.index) || value.match.index < 0 || value.match.index >= value.count))) throw new GrokSourceError('source_invalid');
  return { snapshot: value.snapshot, offset: value.offset, count: value.count, partial: value.partial,
    match: value.match === null ? null : { offset: Number(value.match.offset), index: Number(value.match.index) } };
}
async function searchSession(root: string, session: GrokSession, request: AgentExternalSessionsListCandidatesRequest,
  state: Progress, query: string) {
  const path = await grokFile(root, session, 'chat_history.jsonl');
  const info = await stat(path);
  if (state.snapshot && state.snapshot !== grokFileSnapshot(info)) throw new GrokSourceError('source_invalid');
  state.snapshot = grokFileSnapshot(info);
  if (state.offset > info.size) throw new GrokSourceError('source_invalid');
  const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  return searchExternalSessionContent({ query, control, isScanComplete: () => state.offset === info.size,
    async decode(matchText) {
      await control.prepare(async () => {
        if (state.offset >= info.size) return true;
        const page = await readJsonlFileForwardLines({ filePath: path, offsetBytes: state.offset,
          maxBytes: info.size - state.offset, maxItems: info.size - state.offset, maxOversizeLineBytes: info.size - state.offset,
          onDiagnostic: () => { state.partial = true; },
          onLine(line) {
            request.signal.throwIfAborted();
            const row = decodeGrokRecord(line.value, line.startOffsetBytes);
            if (row) {
              state.partial ||= row.partial === true;
              if (!state.match && row.text !== undefined && matchText(row.text) !== null) state.match = { offset: line.startOffsetBytes, index: state.count };
              state.count++;
            }
            // Commit native position before yielding, including records with
            // no visible item. The scanner can consume its chunk once instead
            // of reopening/re-reading the same chunk for every short record.
            state.offset = Math.min(info.size, line.endOffsetBytes + 1);
            if (state.offset < info.size) control.checkWork();
          },
        });
        if (!page.reachedEnd) throw new GrokSourceError('source_invalid');
        state.offset = info.size;
        state.partial ||= page.truncated;
        return true;
      });
      request.signal.throwIfAborted();
      if (state.snapshot !== grokFileSnapshot(await stat(path))) throw new GrokSourceError('source_invalid');
      if (!state.match) return { records: [], partial: state.partial };
      const page = await readJsonlFileForwardLines({ filePath: path, offsetBytes: state.match.offset,
        maxBytes: info.size - state.match.offset, maxItems: 1, maxOversizeLineBytes: info.size - state.match.offset });
      const line = page.items[0];
      const row = line ? decodeGrokRecord(line.value, line.startOffsetBytes) : null;
      const snippet = row?.text === undefined ? null : matchText(row.text);
      if (!row || snippet === null) throw new GrokSourceError('source_invalid');
      if (state.snapshot !== grokFileSnapshot(await stat(path))) throw new GrokSourceError('source_invalid');
      return { records: [{ id: row.item.id, snippet, messageIndex: state.match.index }], partial: state.partial };
    },
  });
}

export async function listGrokCandidates(root: string, request: AgentExternalSessionsListCandidatesRequest): Promise<AgentExternalSessionsListCandidatesResult> {
  const query = request.searchTerm ?? ''; const target = request.searchTarget ?? 'metadata';
  let after = ''; let pending: string | undefined; let state: Progress | undefined;
  if (request.cursor) {
    const cursor = decode(request.cursor);
    if (cursor.v !== 1 || cursor.root !== root || cursor.query !== query || cursor.target !== target || typeof cursor.after !== 'string'
      || (cursor.pending !== undefined && typeof cursor.pending !== 'string') || ((cursor.pending === undefined) !== (cursor.progress === undefined))) throw new GrokSourceError('source_invalid');
    after = cursor.after;
    if (typeof cursor.pending === 'string') { pending = cursor.pending; state = progress(cursor.progress); }
  }
  const sessions = (await listGrokSessions(root, request.signal)).filter(item => item.id > after);
  if (pending && sessions[0]?.id !== pending) throw new GrokSourceError('source_invalid');
  const candidates: AgentExternalSessionCandidate[] = []; let partial = false; let nextCursor: string | null = null;
  const page = (cursor: string | null): AgentExternalSessionsListCandidatesResult => ({
    candidates, nextCursor: cursor, searchIncomplete: partial || cursor !== null,
    ...(target === 'content' ? { contentCoverage: partial || cursor !== null ? 'partial' : 'complete' } : {}),
  });
  for (let index = 0; index < sessions.length; index++) {
    request.signal.throwIfAborted(); const session = sessions[index]!;
    const previousCandidateCount = candidates.length;
    const content = state ?? { snapshot: '', offset: 0, count: 0, partial: false, match: null };
    const continuation = () => encode({ v: 1, root, query, target, after, pending: session.id, progress: content });
    try {
      const summary = await readGrokSummary(root, session);
      const candidate: AgentExternalSessionCandidate = { remoteSessionId: session.id, cwd: summary.cwd, updatedAtMs: summary.updatedAtMs,
        ...(summary.title ? { title: summary.title } : {}),
        ...(summary.createdAtMs === null ? {} : { createdAtMs: summary.createdAtMs }) };
      if (target === 'content') {
        const found = await searchSession(root, session, request, content, query);
        partial ||= found.partial;
        if (found.match) candidates.push({ ...candidate, match: found.match, ...(!found.partial ? { messageCount: content.count } : {}) });
      } else if (!query || `${summary.title ?? ''}\n${summary.cwd}\n${session.id}`.toLowerCase().includes(query.toLowerCase())) candidates.push(candidate);
    } catch (error) {
      request.signal.throwIfAborted();
      if (error instanceof ExternalSessionContentSearchYield) { nextCursor = continuation(); break; }
      if (error instanceof GrokSourceError && error.code === 'source_invalid') throw error;
      partial = true;
    }
    const remainingCursor = index < sessions.length - 1 ? encode({ v: 1, root, query, target, after: session.id }) : null;
    if (!isAgentExternalSessionsResultWithinByteBudget({ ok: true, value: page(remainingCursor) }, request.maxSerializedBytes)) {
      candidates.splice(previousCandidateCount);
      if (candidates.length === 0) throw new GrokSourceError('agent_error');
      nextCursor = encode({ v: 1, root, query, target, after }); break;
    }
    after = session.id; state = undefined;
    if (index < sessions.length - 1 && (candidates.length >= request.maxItems
      || ((request.scanDeadlineAtMs ?? request.deadlineAtMs) !== undefined && Date.now() >= (request.scanDeadlineAtMs ?? request.deadlineAtMs)!))) {
      nextCursor = encode({ v: 1, root, query, target, after }); break;
    }
  }
  return page(nextCursor);
}
