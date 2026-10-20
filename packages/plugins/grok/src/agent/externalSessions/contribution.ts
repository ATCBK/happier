import { join } from 'node:path';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation, AgentExternalSessionsResult, AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import { listGrokCandidates } from './candidates.js';
import { decode, encode, fingerprint, findGrokSession, grokFailureCode, grokSessionsRoot, GrokSourceError,
  listGrokSessions, readGrokSummary } from './source.js';
import { grokPrefix, readGrokTranscript } from './transcript.js';

type Cursor = { v: 1; root: string; id: string; identity: string; count: number; position: number; prefix: string };
function readCursor(raw: string): Cursor {
  const value = decode(raw);
  if (value.v !== 1 || typeof value.root !== 'string' || typeof value.id !== 'string' || typeof value.identity !== 'string'
    || typeof value.prefix !== 'string' || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0
    || typeof value.position !== 'number' || !Number.isSafeInteger(value.position) || value.position < 0 || value.position > value.count) throw new GrokSourceError('source_invalid');
  return { v: 1, root: value.root, id: value.id, identity: value.identity, count: value.count, position: value.position, prefix: value.prefix };
}
async function guarded<T>(request: AgentExternalSessionsInvocation, operation: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
  try {
    const result = { ok: true as const, value: await operation() };
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result
      : { ok: false, code: 'agent_error', message: 'Grok native history exceeds the caller result budget.' };
  } catch (error) {
    return getAgentExternalSessionsInvocationFailure(request) ?? { ok: false, code: grokFailureCode(error), message: 'Grok native history is unavailable or unsupported.' };
  }
}
function validateMaxItems(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new GrokSourceError('invalid_request'); }

export function createGrokExternalSessionsContribution(env: () => NodeJS.ProcessEnv = () => process.env): AgentExternalSessionsContribution {
  const identity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
    const root = grokSessionsRoot(request.source, env());
    await readGrokSummary(root, await findGrokSession(root, request.remoteSessionId, request.signal));
    return { source: { kind: 'grokHome' }, remoteSessionId: request.remoteSessionId, linkData: {} };
  });
  return {
    resolveSource: request => guarded(request, async () => {
      const root = grokSessionsRoot(request.source, env()); const source = { kind: 'grokHome' };
      if (request.includeAccountingSource === false) return { source };
      const inventory = await discoverAgentAccountingJsonlSource([root], request.signal);
      if (!inventory.available) throw new GrokSourceError('source_unreachable');
      const files = new Set(inventory.files);
      for (const session of await listGrokSessions(root, request.signal)) {
        files.add(join(session.dir, 'summary.json')); files.add(join(session.dir, 'chat_history.jsonl'));
      }
      return { source, accountingSource: { rootPath: root, resourceKey: `grok:transcripts:${fingerprint(root)}`,
        changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [...files].sort(), topologyDirectories: [...inventory.topologyDirectories] } } };
    }),
    listCandidates: request => guarded(request, async () => { validateMaxItems(request.maxItems); return listGrokCandidates(grokSessionsRoot(request.source, env()), request); }),
    resolveLinkIdentity: identity,
    resolveLinkedIdentity: identity,
    pageTranscript: request => guarded(request, async () => {
      validateMaxItems(request.maxItems);
      const root = grokSessionsRoot(request.source, env());
      const projection = await readGrokTranscript(root, await findGrokSession(root, request.remoteSessionId, request.signal), request.signal);
      const prior = request.cursor ? readCursor(request.cursor) : null;
      if (prior && (prior.root !== root || prior.id !== request.remoteSessionId || prior.identity !== projection.identity
        || prior.count > projection.rows.length || prior.prefix !== grokPrefix(projection.rows, prior.count))) throw new GrokSourceError('source_invalid');
      const count = prior?.count ?? projection.rows.length;
      let position = prior?.position ?? (request.direction === 'older' ? count : 0);
      const base: Cursor = { v: 1, root, id: request.remoteSessionId, identity: projection.identity, count, position: count, prefix: grokPrefix(projection.rows, count) };
      const items: AgentExternalSessionsTranscriptPage['items'][number][] = [];
      while (items.length < request.maxItems && (request.direction === 'older' ? position > 0 : position < count)) {
        const index = request.direction === 'older' ? position - 1 : position;
        const nextItems = request.direction === 'older' ? [projection.rows[index]!.item, ...items] : [...items, projection.rows[index]!.item];
        const nextPosition = position + (request.direction === 'older' ? -1 : 1);
        const trial = { ok: true as const, value: { items: nextItems, nextCursor: encode({ ...base, position: nextPosition }), tailCursor: encode(base), hasMore: true, truncated: projection.partial } };
        if (!isAgentExternalSessionsResultWithinByteBudget(trial, request.maxSerializedBytes)) {
          if (!items.length) throw new GrokSourceError('agent_error'); break;
        }
        items.splice(0, items.length, ...nextItems); position = nextPosition;
      }
      const hasMore = request.direction === 'older' ? position > 0 : position < count;
      return { items, nextCursor: hasMore ? encode({ ...base, position }) : null, tailCursor: encode(base), hasMore, truncated: projection.partial };
    }),
    readAfterTranscript: request => guarded(request, async () => {
      validateMaxItems(request.maxItems);
      const root = grokSessionsRoot(request.source, env()); const prior = readCursor(request.cursor);
      if (prior.root !== root || prior.id !== request.remoteSessionId) throw new GrokSourceError('source_invalid');
      let projection: Awaited<ReturnType<typeof readGrokTranscript>>;
      try { projection = await readGrokTranscript(root, await findGrokSession(root, request.remoteSessionId, request.signal), request.signal); }
      catch (error) {
        if (error instanceof GrokSourceError && error.code === 'candidate_not_found') return { outcome: 'source_unavailable' as const };
        throw error;
      }
      if (prior.identity !== projection.identity) return { outcome: 'source_replaced' as const };
      if (prior.count > projection.rows.length || prior.prefix !== grokPrefix(projection.rows, prior.count)) return { outcome: 'gap_or_cursor_expired' as const };
      if (prior.count === projection.rows.length) return projection.partial ? { outcome: 'read_failed' as const } : { outcome: 'already_current' as const };
      let count = prior.count; const items: AgentExternalSessionsTranscriptPage['items'][number][] = [];
      while (count < projection.rows.length && items.length < request.maxItems) {
        const nextItems = [...items, projection.rows[count]!.item];
        // SHA-256 base64url witnesses have equal serialized width. Budget the
        // trial with the retained witness and hash only the final chosen prefix.
        const cursor = encode({ ...prior, count: count + 1, position: count + 1 });
        if (!isAgentExternalSessionsResultWithinByteBudget({ ok: true, value: { outcome: 'advanced', items: nextItems, nextCursor: cursor, boundary: projection.identity, hasMore: true } }, request.maxSerializedBytes)) {
          if (!items.length) throw new GrokSourceError('agent_error'); break;
        }
        items.push(projection.rows[count]!.item); count++;
      }
      return { outcome: 'advanced' as const, items, nextCursor: encode({ ...prior, count, position: count, prefix: grokPrefix(projection.rows, count) }), boundary: projection.identity, hasMore: count < projection.rows.length };
    }),
  };
}
export const grokExternalSessionsContribution = createGrokExternalSessionsContribution();
