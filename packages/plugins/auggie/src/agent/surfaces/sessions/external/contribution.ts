import { join } from 'node:path';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocationBounds, AgentExternalSessionsResult,
  AgentExternalSessionTranscriptItem, AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { listAuggieCandidates } from './candidates.js';
import { AuggieSourceError, decode, encode, fingerprint, readSession, record, resolveAuggieStore, sessionIds } from './source.js';
import { projectAuggieTranscript } from './transcript.js';

async function guarded<T>(request: AgentExternalSessionsInvocationBounds, work: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
  try {
    const value = await work(); const cancelled = getAgentExternalSessionsInvocationFailure(request); if (cancelled) return cancelled;
    const result = { ok: true as const, value };
    return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result
      : { ok: false, code: 'agent_error', message: 'Auggie native result exceeds caller byte budget.' };
  } catch (error) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    const code = error instanceof AuggieSourceError ? error.code : record(error) && error.code === 'ENOENT' ? 'unavailable' : 'source_unreachable';
    return { ok: false, code, message: `Auggie native history: ${code}.`, ...(code === 'unavailable' ? { retryable: true } : {}) };
  }
}
type Frontier = { v: 1; source: string; session: string; count: number; hash: string };
function frontier(root: string, session: string, items: readonly AgentExternalSessionTranscriptItem[]): Frontier {
  return { v: 1, source: fingerprint(root), session, count: items.length, hash: fingerprint(items) };
}
function parseFrontier(raw: string, root: string, session: string): Frontier | null {
  const v = decode(raw);
  return v?.v === 1 && v.source === fingerprint(root) && v.session === session && Number.isSafeInteger(v.count) && Number(v.count) >= 0 && typeof v.hash === 'string'
    ? { v: 1, source: String(v.source), session, count: Number(v.count), hash: v.hash } : null;
}
function fits(value: unknown, bytes: number) { return isAgentExternalSessionsResultWithinByteBudget({ ok: true, value }, bytes); }

export function createAuggieExternalSessionsContribution(env: NodeJS.ProcessEnv = process.env): AgentExternalSessionsContribution {
  const identity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
    const store = await resolveAuggieStore(request.source, env); await readSession(store, request.remoteSessionId, request.signal);
    return { source: store.source, remoteSessionId: request.remoteSessionId, linkData: {} };
  });
  return {
    resolveSource: request => guarded(request, async () => {
      const store = await resolveAuggieStore(request.source, env);
      if (request.includeAccountingSource === false) return { source: store.source };
      const files = (await sessionIds(store, request.signal)).map(id => join(store.sessions, `${id}.json`));
      return { source: store.source, accountingSource: { rootPath: store.root, rootField: 'augmentHome', resourceKey: `auggie-native:${fingerprint(store.root)}`,
        changeObservation: 'watch_file_changes' as const, watchFileChanges: { files: files.length ? files : [store.sessions], topologyDirectories: [store.sessions] } } };
    }),
    listCandidates: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new AuggieSourceError('invalid_request');
      return listAuggieCandidates(await resolveAuggieStore(request.source, env), request);
    }),
    resolveLinkIdentity: identity, resolveLinkedIdentity: identity,
    pageTranscript: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new AuggieSourceError('invalid_request');
      const store = await resolveAuggieStore(request.source, env); const session = await readSession(store, request.remoteSessionId, request.signal);
      const projection = projectAuggieTranscript(session, request.signal); const items = projection.items;
      const previous = request.cursor ? parseFrontier(request.cursor, store.root, session.id) : null;
      if (request.cursor && (!previous || previous.count > items.length || fingerprint(items.slice(0, previous.count)) !== previous.hash)) throw new AuggieSourceError('source_invalid');
      let start: number; let end: number;
      if (request.direction === 'older') { end = previous?.count ?? items.length; start = Math.max(0, end - request.maxItems); }
      else { start = previous?.count ?? 0; end = Math.min(items.length, start + request.maxItems); }
      const build = (): AgentExternalSessionsTranscriptPage => {
        const more = request.direction === 'older' ? start > 0 : end < items.length;
        return { items: items.slice(start, end), hasMore: more,
          nextCursor: more ? encode(frontier(store.root, session.id, items.slice(0, request.direction === 'older' ? start : end))) : null,
          tailCursor: encode(frontier(store.root, session.id, items.slice(0, end))),
          ...(projection.partial ? { diagnostics: [{ code: 'unsupported_record', severity: 'required', count: 1, positions: [] }] } : {}) };
      };
      while (!fits(build(), request.maxSerializedBytes)) { if (end - start <= 1) throw new AuggieSourceError('agent_error'); if (request.direction === 'older') start++; else end--; }
      return build();
    }),
    readAfterTranscript: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new AuggieSourceError('invalid_request');
      const store = await resolveAuggieStore(request.source, env);
      let session;
      try { session = await readSession(store, request.remoteSessionId, request.signal); }
      catch (error) { if (record(error) && error.code === 'ENOENT') return { outcome: 'source_unavailable' as const }; throw error; }
      const previous = parseFrontier(request.cursor, store.root, session.id);
      if (!previous) return { outcome: 'gap_or_cursor_expired' as const };
      const projection = projectAuggieTranscript(session, request.signal);
      const items = projection.items;
      if (previous.count > items.length || fingerprint(items.slice(0, previous.count)) !== previous.hash) return { outcome: 'source_replaced' as const };
      if (previous.count === items.length) return { outcome: projection.partial ? 'read_failed' as const : 'already_current' as const };
      let end = Math.min(items.length, previous.count + request.maxItems);
      const build = () => ({ outcome: 'advanced' as const, items: items.slice(previous.count, end),
        nextCursor: encode(frontier(store.root, session.id, items.slice(0, end))), boundary: fingerprint([store.root, session.id]), hasMore: end < items.length,
        ...(projection.partial ? { diagnostics: [{ code: 'unsupported_record', severity: 'required' as const, count: 1, positions: [] }] } : {}) });
      while (!fits(build(), request.maxSerializedBytes)) { if (end - previous.count <= 1) throw new AuggieSourceError('agent_error'); end--; }
      return build();
    }),
  };
}
export const auggieExternalSessionsContribution: AgentExternalSessionsContribution = createAuggieExternalSessionsContribution();
