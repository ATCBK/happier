import { join } from 'node:path';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocationBounds, AgentExternalSessionsResult,
  AgentExternalSessionTranscriptItem, AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { listKimiCandidates } from './candidates.js';
import { decode, encode, findKimiSession, fingerprint, KimiStoreError, listKimiSessions, record, resolveKimiStore } from './source.js';
import { readKimiTranscript } from './wireTranscript.js';

function ok<T>(value: T): AgentExternalSessionsResult<T> { return { ok: true, value }; }
async function guarded<T>(request: AgentExternalSessionsInvocationBounds, work: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
  try {
    const value = await work();
    const cancelled = getAgentExternalSessionsInvocationFailure(request); if (cancelled) return cancelled;
    const result = ok(value);
    return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result
      : { ok: false, code: 'agent_error', message: 'Kimi Code native result exceeds caller byte budget.' };
  } catch (error) {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    const code = error instanceof KimiStoreError ? error.code : record(error) && error.code === 'ENOENT' ? 'unavailable' : 'agent_error';
    return { ok: false, code, message: `Kimi Code native history: ${code}.`, ...(code === 'unavailable' ? { retryable: true } : {}) };
  }
}
type Frontier = { v: 1; source: string; session: string; identity: string; count: number; hash: string };
function frontier(root: string, session: string, identity: string, items: readonly AgentExternalSessionTranscriptItem[]): Frontier {
  return { v: 1, source: fingerprint(root), session, identity, count: items.length, hash: fingerprint(items) };
}
function parseFrontier(raw: string, root: string, session: string): Frontier | null {
  const value = decode(raw);
  return value?.v === 1 && value.source === fingerprint(root) && value.session === session
    && Number.isSafeInteger(value.count) && Number(value.count) >= 0 && typeof value.hash === 'string' && typeof value.identity === 'string'
    ? { v: 1, source: String(value.source), session, identity: value.identity, count: Number(value.count), hash: value.hash } : null;
}
function fits(value: unknown, bytes: number): boolean { return isAgentExternalSessionsResultWithinByteBudget(ok(value), bytes); }
function requireLimit(maxItems: number) { if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw new KimiStoreError('invalid_request'); }
const diagnostics = [{ code: 'unsupported_record', severity: 'required' as const, count: 1, positions: [] }];

const resolveIdentity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
  const store = await resolveKimiStore(request.source);
  const session = await findKimiSession(store, request.remoteSessionId, request.signal);
  return { source: store.source, remoteSessionId: session.id, linkData: {} };
});

export const kimiExternalSessionsContribution: AgentExternalSessionsContribution = {
  resolveSource: request => guarded(request, async () => {
    const store = await resolveKimiStore(request.source);
    if (request.includeAccountingSource === false) return { source: store.source };
    const inventory = await listKimiSessions(store, request.signal);
    return { source: store.source, accountingSource: { rootPath: store.root, rootField: 'homeDir',
      resourceKey: `kimi-code:${fingerprint(store.root)}`, changeObservation: 'watch_file_changes' as const,
      watchFileChanges: { files: inventory.files, topologyDirectories: [join(store.root, 'sessions'), store.root] } } };
  }),
  listCandidates: request => guarded(request, async () => {
    requireLimit(request.maxItems);
    return listKimiCandidates(await resolveKimiStore(request.source), request);
  }),
  resolveLinkIdentity: resolveIdentity,
  resolveLinkedIdentity: resolveIdentity,
  pageTranscript: request => guarded(request, async () => {
    requireLimit(request.maxItems);
    const store = await resolveKimiStore(request.source);
    const session = await findKimiSession(store, request.remoteSessionId, request.signal);
    const projection = await readKimiTranscript(session, request.signal);
    const items = projection.items;
    const previous = request.cursor ? parseFrontier(request.cursor, store.root, session.id) : null;
    if (request.cursor && (!previous || previous.identity !== projection.identity || previous.count > items.length
      || fingerprint(items.slice(0, previous.count)) !== previous.hash)) throw new KimiStoreError('source_invalid');
    let start: number; let end: number;
    if (request.direction === 'older') { end = previous?.count ?? items.length; start = Math.max(0, end - request.maxItems); }
    else { start = previous?.count ?? 0; end = Math.min(items.length, start + request.maxItems); }
    const build = (): AgentExternalSessionsTranscriptPage => {
      const more = request.direction === 'older' ? start > 0 : end < items.length;
      return { items: items.slice(start, end), hasMore: more,
        nextCursor: more ? encode(frontier(store.root, session.id, projection.identity, items.slice(0, request.direction === 'older' ? start : end))) : null,
        tailCursor: encode(frontier(store.root, session.id, projection.identity, items.slice(0, end))),
        ...(projection.partial ? { truncated: true, diagnostics } : {}) };
    };
    while (!fits(build(), request.maxSerializedBytes)) {
      if (end - start <= 1) throw new KimiStoreError('agent_error');
      if (request.direction === 'older') start++; else end--;
    }
    return build();
  }),
  readAfterTranscript: request => guarded(request, async () => {
    requireLimit(request.maxItems);
    const store = await resolveKimiStore(request.source);
    let session;
    try { session = await findKimiSession(store, request.remoteSessionId, request.signal); }
    catch (error) { if (error instanceof KimiStoreError && error.code === 'candidate_not_found') return { outcome: 'source_unavailable' as const }; throw error; }
    const previous = parseFrontier(request.cursor, store.root, session.id);
    if (!previous) return { outcome: 'gap_or_cursor_expired' as const };
    const projection = await readKimiTranscript(session, request.signal);
    const items = projection.items;
    if (previous.identity !== projection.identity || previous.count > items.length
      || fingerprint(items.slice(0, previous.count)) !== previous.hash) return { outcome: 'source_replaced' as const };
    // The tail ABI has no partial-coverage arm. Keep the last valid index and
    // report a failed read rather than marking an incomplete replay current.
    if (projection.partial) return { outcome: 'read_failed' as const };
    if (previous.count === items.length) return { outcome: 'already_current' as const };
    let end = Math.min(items.length, previous.count + request.maxItems);
    const build = () => ({ outcome: 'advanced' as const, items: items.slice(previous.count, end),
      nextCursor: encode(frontier(store.root, session.id, projection.identity, items.slice(0, end))),
      boundary: fingerprint([store.root, session.id]), hasMore: end < items.length,
      ...(projection.partial ? { diagnostics } : {}) });
    while (!fits(build(), request.maxSerializedBytes)) { if (end - previous.count <= 1) throw new KimiStoreError('agent_error'); end--; }
    return build();
  }),
};
