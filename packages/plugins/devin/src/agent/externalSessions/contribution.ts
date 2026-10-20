import type {
  AgentExternalSessionCandidate, AgentExternalSessionsContribution, AgentExternalSessionsFailureCode,
  AgentExternalSessionsInvocation, AgentExternalSessionsResult, AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord } from '@happier-dev/plugin-sdk';
import { DevinSourceError, digest, resolveDevinSource } from './source.js';
import { withDevinDatabase } from './nativeDatabase.js';
import { devinPrefixIdentity, listDevinSessions, readDevinTranscript, type DevinTranscript } from './transcript.js';

function ok<T>(value: T): AgentExternalSessionsResult<T> { return { ok: true, value }; }
function fail(code: AgentExternalSessionsFailureCode, message: string): AgentExternalSessionsResult<never> { return { ok: false, code, message }; }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(text: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString()); return isRecord(parsed) ? parsed : null; } catch { return null; }
}
const validCount = (value: number) => Number.isSafeInteger(value) && value > 0;
type ReadAfterValue = Extract<Awaited<ReturnType<AgentExternalSessionsContribution['readAfterTranscript']>>, { ok: true }>['value'];
function cursorFor(snapshot: DevinTranscript, path: string, id: string, end: number) {
  return encode({ v: 1, source: digest(path), id, end, prefix: devinPrefixIdentity(snapshot, end) });
}
function parseCursor(cursor: string, snapshot: DevinTranscript, path: string, id: string) {
  const parsed = decode(cursor);
  if (!parsed || parsed.v !== 1 || parsed.source !== digest(path) || parsed.id !== id || typeof parsed.end !== 'number'
    || !Number.isSafeInteger(parsed.end) || parsed.end < 0 || parsed.end > snapshot.rows.length
    || parsed.prefix !== devinPrefixIdentity(snapshot, parsed.end)) return null;
  return parsed.end;
}

export function createDevinExternalSessionsContribution(options: Readonly<{ env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }> = {}): AgentExternalSessionsContribution {
  const resolve = (source: Parameters<AgentExternalSessionsContribution['resolveSource']>[0]['source']) =>
    resolveDevinSource(source, options.env ?? process.env, options.platform);
  async function guarded<T>(request: AgentExternalSessionsInvocation, work: () => Promise<AgentExternalSessionsResult<T>>): Promise<AgentExternalSessionsResult<T>> {
    const stopped = getAgentExternalSessionsInvocationFailure(request);
    if (stopped) return stopped;
    try {
      const result = await work();
      const finished = getAgentExternalSessionsInvocationFailure(request);
      return finished ?? (isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result
        : fail('agent_error', 'Devin result exceeds the caller byte allowance.'));
    } catch (error) {
      const finished = getAgentExternalSessionsInvocationFailure(request);
      if (finished) return finished;
      return error instanceof DevinSourceError ? fail(error.code, error.message) : fail('unavailable', 'Devin native history could not be read.');
    }
  }
  const identity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
    const source = await resolve(request.source);
    return withDevinDatabase(source.path, request.signal, db => {
      if (!listDevinSessions(db).some(session => session.id === request.remoteSessionId)) return fail('candidate_not_found', 'Devin session is absent or hidden.');
      return ok({ source: source.source, remoteSessionId: request.remoteSessionId, linkData: {} });
    });
  });
  return {
    resolveSource: request => guarded(request, async () => {
      const source = await resolve(request.source);
      return ok({ source: source.source, ...(request.includeAccountingSource === false ? {} : { accountingSource: {
        rootPath: source.root, resourceKey: 'devin:native:' + digest(source.path), changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [source.path, source.path + '-wal'], topologyDirectories: [source.root] },
      } }) });
    }),
    listCandidates: request => guarded(request, async () => {
      if (!validCount(request.maxItems)) return fail('invalid_request', 'Devin candidate count must be positive.');
      const source = await resolve(request.source);
      const binding = digest(JSON.stringify([source.path, request.searchTarget ?? 'metadata', request.searchTerm ?? '', request.includeThreads === true]));
      const previous = request.cursor ? decode(request.cursor) : null;
      if (request.cursor && (!previous || previous.v !== 1 || previous.binding !== binding || typeof previous.after !== 'string')) return fail('invalid_request', 'Devin candidate cursor does not match the source and query.');
      const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs });
      return withDevinDatabase(source.path, request.signal, async (db, walPresent) => {
        const sessions = listDevinSessions(db);
        let position = previous ? sessions.findIndex(session => session.id > String(previous.after)) : 0;
        if (position < 0) position = sessions.length;
        let after = previous ? String(previous.after) : '';
        const candidates: AgentExternalSessionCandidate[] = [];
        // SQLite can discard a torn WAL tail. An empty copied WAL store is
        // not authoritative complete-empty evidence.
        let partial = walPresent && sessions.length === 0;
        try {
          await control.prepare(async () => {
            if (position >= sessions.length) return true;
            const session = sessions[position]!;
            let candidate: AgentExternalSessionCandidate | null = {
              remoteSessionId: session.id, cwd: session.cwd, ...(session.title ? { title: session.title } : {}),
              createdAtMs: session.createdAtMs, updatedAtMs: session.updatedAtMs,
            };
            if (request.searchTarget === 'content') {
              try {
                const snapshot = readDevinTranscript(db, session, request.signal);
                const result = await searchExternalSessionContent({
                  query: request.searchTerm ?? '', control, isScanComplete: () => true,
                  decode: async matchText => ({ partial: snapshot.partial || (walPresent && snapshot.rows.length === 0),
                    records: snapshot.rows.map((row, messageIndex) => {
                      const snippet = row.text ? matchText(row.text) : null;
                      return { id: row.item.id, messageIndex, ...(snippet !== null ? { snippet } : {}) };
                    }) }),
                });
                partial ||= result.partial;
                candidate = result.match ? { ...candidate, match: result.match } : null;
              } catch (error) {
                if (!(error instanceof DevinSourceError)) throw error;
                partial = true; candidate = null;
              }
            } else if (request.searchTerm && ![session.id, session.title ?? '', session.cwd].join('\n').toLowerCase().includes(request.searchTerm.toLowerCase())) candidate = null;
            if (candidate) {
              const cursor = position + 1 < sessions.length ? encode({ v: 1, binding, after: session.id }) : null;
              if (!isAgentExternalSessionsResultWithinByteBudget(ok({ candidates: [...candidates, candidate], nextCursor: cursor, contentCoverage: 'partial' }), request.maxSerializedBytes)) {
                if (!candidates.length) throw new DevinSourceError('unavailable', 'One Devin candidate exceeds the caller byte allowance.');
                return true;
              }
              candidates.push(candidate);
            }
            after = session.id; position++;
            return position >= sessions.length || candidates.length >= request.maxItems;
          });
        } catch (error) {
          if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
          partial = true;
        }
        const nextCursor = position < sessions.length ? encode({ v: 1, binding, after }) : null;
        return ok({ candidates, nextCursor,
          ...(request.searchTarget === 'content' ? { contentCoverage: partial || nextCursor ? 'partial' as const : 'complete' as const } : {}),
          ...(partial ? { searchIncomplete: true } : {}) });
      });
    }),
    resolveLinkIdentity: identity,
    resolveLinkedIdentity: identity,
    pageTranscript: request => guarded(request, async () => {
      if (!validCount(request.maxItems)) return fail('invalid_request', 'Devin transcript count must be positive.');
      const source = await resolve(request.source);
      return withDevinDatabase(source.path, request.signal, (db, walPresent) => {
        const session = listDevinSessions(db).find(session => session.id === request.remoteSessionId);
        if (!session) return fail('candidate_not_found', 'Devin session is absent or hidden.');
        const snapshot = readDevinTranscript(db, session, request.signal);
        const parsed = request.cursor ? parseCursor(request.cursor, snapshot, source.path, session.id) : null;
        if (request.cursor && parsed === null) return fail('source_invalid', 'Devin transcript changed or its cursor is invalid.');
        const end = parsed ?? (request.direction === 'older' ? snapshot.rows.length : 0);
        let start = request.direction === 'older' ? Math.max(0, end - request.maxItems) : end;
        let finish = request.direction === 'older' ? end : Math.min(snapshot.rows.length, end + request.maxItems);
        const build = (): AgentExternalSessionsTranscriptPage => ({
          items: snapshot.rows.slice(start, finish).map(row => row.item),
          nextCursor: request.direction === 'older'
            ? start > 0 ? cursorFor(snapshot, source.path, session.id, start) : null
            : finish < snapshot.rows.length ? cursorFor(snapshot, source.path, session.id, finish) : null,
          tailCursor: cursorFor(snapshot, source.path, session.id, finish),
          hasMore: request.direction === 'older' ? start > 0 : finish < snapshot.rows.length,
          truncated: snapshot.partial || (walPresent && snapshot.rows.length === 0),
        });
        while (finish > start && !isAgentExternalSessionsResultWithinByteBudget(ok(build()), request.maxSerializedBytes)) {
          if (request.direction === 'older') start++; else finish--;
        }
        if (start === finish && snapshot.rows.length) return fail('agent_error', 'One Devin transcript item exceeds the caller byte allowance.');
        return ok(build());
      });
    }),
    readAfterTranscript: request => guarded<ReadAfterValue>(request, async () => {
      if (!validCount(request.maxItems)) return fail('invalid_request', 'Devin transcript count must be positive.');
      const source = await resolve(request.source);
      return withDevinDatabase(source.path, request.signal, (db, walPresent) => {
        const session = listDevinSessions(db).find(session => session.id === request.remoteSessionId);
        // Only a successfully read native store can prove a session retired.
        if (!session) return ok({ outcome: 'source_unavailable' as const });
        const snapshot = readDevinTranscript(db, session, request.signal);
        if (snapshot.partial || (walPresent && snapshot.rows.length === 0)) return fail('unsupported', 'Devin native transcript is incomplete.');
        const start = parseCursor(request.cursor, snapshot, source.path, session.id);
        if (start === null) return ok({ outcome: 'source_replaced' as const });
        if (start === snapshot.rows.length) return ok({ outcome: 'already_current' as const });
        let end = Math.min(start + request.maxItems, snapshot.rows.length);
        const build = () => ({ outcome: 'advanced' as const, items: snapshot.rows.slice(start, end).map(row => row.item),
          nextCursor: cursorFor(snapshot, source.path, session.id, end), boundary: digest(source.path), hasMore: end < snapshot.rows.length });
        while (end > start && !isAgentExternalSessionsResultWithinByteBudget(ok(build()), request.maxSerializedBytes)) end--;
        if (end === start) return fail('agent_error', 'One Devin transcript item exceeds the caller byte allowance.');
        return ok(build());
      });
    }),
  };
}
export const devinExternalSessionsContribution: AgentExternalSessionsContribution = createDevinExternalSessionsContribution();
