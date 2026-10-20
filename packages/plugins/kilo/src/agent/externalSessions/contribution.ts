import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocationBounds, AgentExternalSessionsResult,
  AgentExternalSessionTranscriptItem, AgentExternalSessionsTranscriptPage, AgentExternalSessionsResolvedIdentity } from '@happier-dev/plugin-sdk/sessions/external';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { listKiloCandidates } from './candidates.js';
import { readTranscript } from './messages.js';
import { decode, encode, findSession, fingerprint, KiloStoreError, observationFiles, record, resolveKiloStore } from './source.js';

function ok<T>(value: T): AgentExternalSessionsResult<T> { return { ok: true, value }; }
async function guarded<T>(request: AgentExternalSessionsInvocationBounds, work: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
  try {
    const value = await work();
    const cancelled = getAgentExternalSessionsInvocationFailure(request); if (cancelled) return cancelled;
    const result = ok(value);
    return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result : { ok: false, code: 'agent_error', message: 'Kilo native result exceeds caller byte budget.' };
  } catch (error) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    const code = error instanceof KiloStoreError ? error.code : record(error) && error.code === 'ENOENT' ? 'unavailable' : 'agent_error';
    return { ok: false, code, message: `Kilo native history: ${code}.`, ...(code === 'unavailable' ? { retryable: true } : {}) };
  }
}
type Frontier = { v: 1; source: string; session: string; count: number; hash: string };
// This JSON dialect rewrites existing parts and revert metadata in place.
// Recompute the projection and verify the retained prefix before appending;
// listing timestamps cannot prove transcript continuity. Cursors retain no text.
function frontier(root: string, session: string, items: readonly AgentExternalSessionTranscriptItem[]): Frontier {
  return { v: 1, source: fingerprint(root), session, count: items.length, hash: fingerprint(items) };
}
function parseFrontier(raw: string, root: string, session: string): Frontier | null {
  const value = decode(raw);
  return value?.v === 1 && value.source === fingerprint(root) && value.session === session
    && Number.isSafeInteger(value.count) && Number(value.count) >= 0 && typeof value.hash === 'string'
    ? { v: 1, source: String(value.source), session, count: Number(value.count), hash: value.hash } : null;
}
function fits(value: unknown, bytes: number): boolean { return isAgentExternalSessionsResultWithinByteBudget(ok(value), bytes); }

export function createKiloExternalSessionsContribution(env: NodeJS.ProcessEnv = process.env): AgentExternalSessionsContribution {
  const resolveIdentity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
    const store = await resolveKiloStore(request.source, env);
    const session = await findSession(store, request.remoteSessionId, request.signal);
    return { source: store.source, remoteSessionId: session.id, linkData: {} } satisfies AgentExternalSessionsResolvedIdentity;
  });
  return {
    resolveSource: request => guarded(request, async () => {
      const store = await resolveKiloStore(request.source, env);
      if (request.includeAccountingSource === false) return { source: store.source };
      const files = await observationFiles(store, request.signal);
      return { source: store.source, accountingSource: { rootPath: store.root, rootField: 'storageRoot',
        resourceKey: `kilo-json:${fingerprint(store.root)}`, changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files, topologyDirectories: [store.root] } } };
    }),
    listCandidates: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new KiloStoreError('invalid_request');
      return listKiloCandidates(await resolveKiloStore(request.source, env), request);
    }),
    resolveLinkIdentity: resolveIdentity,
    resolveLinkedIdentity: resolveIdentity,
    pageTranscript: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new KiloStoreError('invalid_request');
      const store = await resolveKiloStore(request.source, env);
      const session = await findSession(store, request.remoteSessionId, request.signal);
      const projection = await readTranscript(store, session, request.signal);
      const items = projection.items;
      const previous = request.cursor ? parseFrontier(request.cursor, store.root, session.id) : null;
      if (request.cursor && (!previous || previous.count > items.length || fingerprint(items.slice(0, previous.count)) !== previous.hash)) throw new KiloStoreError('source_invalid');
      let start: number; let end: number;
      if (request.direction === 'older') { end = previous?.count ?? items.length; start = Math.max(0, end - request.maxItems); }
      else { start = previous?.count ?? 0; end = Math.min(items.length, start + request.maxItems); }
      const build = (): AgentExternalSessionsTranscriptPage => {
        const more = request.direction === 'older' ? start > 0 : end < items.length;
        return { items: items.slice(start, end), hasMore: more,
          nextCursor: more ? encode(frontier(store.root, session.id, items.slice(0, request.direction === 'older' ? start : end))) : null,
          tailCursor: encode(frontier(store.root, session.id, items.slice(0, end))),
          ...(projection.partial ? { truncated: true, diagnostics: [{ code: 'unsupported_record', severity: 'required', count: 1, positions: [] }] } : {}) };
      };
      while (!fits(build(), request.maxSerializedBytes)) {
        if (end - start <= 1) throw new KiloStoreError('agent_error');
        if (request.direction === 'older') start++; else end--;
      }
      return build();
    }),
    readAfterTranscript: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new KiloStoreError('invalid_request');
      const store = await resolveKiloStore(request.source, env);
      let session;
      try { session = await findSession(store, request.remoteSessionId, request.signal); }
      catch (error) { if (error instanceof KiloStoreError && error.code === 'candidate_not_found') return { outcome: 'source_unavailable' as const }; throw error; }
      const previous = parseFrontier(request.cursor, store.root, session.id);
      if (!previous) return { outcome: 'gap_or_cursor_expired' as const };
      const projection = await readTranscript(store, session, request.signal);
      const items = projection.items;
      if (projection.partial) return { outcome: 'read_failed' as const };
      if (previous.count > items.length || fingerprint(items.slice(0, previous.count)) !== previous.hash) return { outcome: 'source_replaced' as const };
      if (previous.count === items.length) return { outcome: 'already_current' as const };
      let end = Math.min(items.length, previous.count + request.maxItems);
      const build = () => ({ outcome: 'advanced' as const, items: items.slice(previous.count, end),
        nextCursor: encode(frontier(store.root, session.id, items.slice(0, end))), boundary: fingerprint([store.root, session.id]), hasMore: end < items.length });
      while (!fits(build(), request.maxSerializedBytes)) { if (end - previous.count <= 1) throw new KiloStoreError('agent_error'); end--; }
      return build();
    }),
  };
}
export const kiloExternalSessionsContribution = createKiloExternalSessionsContribution();
