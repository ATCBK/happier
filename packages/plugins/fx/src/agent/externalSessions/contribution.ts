import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation, AgentExternalSessionsResult,
  AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';

import { listFxCandidates } from './candidates.js';
import { fxFailureCode, fxResultFiles, fxSessionDir, fxSessionsRoot, FxSourceError, isFxRecord as isRecord, listFxSessionIds, readFxMetadata } from './source.js';
import { fxPrefix, readFxTranscript } from './transcript.js';

type Cursor = Readonly<{ v: 1; root: string; id: string; identity: string; count: number; position: number; prefix: string }>;
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
function decode(raw: string): Cursor {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString()); } catch { throw new FxSourceError('invalid_request'); }
  if (!isRecord(value) || value.v !== 1 || typeof value.root !== 'string' || typeof value.id !== 'string'
    || typeof value.identity !== 'string' || typeof value.prefix !== 'string'
    || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0
    || typeof value.position !== 'number' || !Number.isSafeInteger(value.position) || value.position < 0 || value.position > value.count) {
    throw new FxSourceError('invalid_request');
  }
  return { v: 1, root: value.root, id: value.id, identity: value.identity,
    count: value.count, position: value.position, prefix: value.prefix };
}

async function guarded<T>(request: AgentExternalSessionsInvocation, operation: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> {
  const stopped = getAgentExternalSessionsInvocationFailure(request);
  if (stopped) return stopped;
  try {
    const result = { ok: true as const, value: await operation() };
    const stopped = getAgentExternalSessionsInvocationFailure(request);
    if (stopped) return stopped;
    return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result
      : { ok: false, code: 'agent_error', message: 'FX native history exceeds the caller result budget.' };
  } catch (error) {
    const stopped = getAgentExternalSessionsInvocationFailure(request);
    return stopped ?? { ok: false, code: fxFailureCode(error), message: 'FX native history is unavailable or unsupported.' };
  }
}

export function createFxExternalSessionsContribution(env: () => NodeJS.ProcessEnv = () => process.env): AgentExternalSessionsContribution {
  const identity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
    const root = fxSessionsRoot(request.source, env());
    await readFxMetadata(root, request.remoteSessionId);
    return { source: { kind: 'fxHome' }, remoteSessionId: request.remoteSessionId, linkData: {} };
  });
  return {
    resolveSource: request => guarded(request, async () => {
      const root = fxSessionsRoot(request.source, env());
      const source = { kind: 'fxHome' };
      if (request.includeAccountingSource === false) return { source };
      const inventory = await discoverAgentAccountingJsonlSource([root], request.signal);
      if (!inventory.available) throw new FxSourceError('source_unreachable');
      const files = new Set(inventory.files);
      const directories = new Set(inventory.topologyDirectories);
      for (const id of (await listFxSessionIds(root, request.signal)).ids) {
        const dir = await fxSessionDir(root, id);
        files.add(join(dir, 'session.json'));
        const results = await fxResultFiles(dir);
        request.signal.throwIfAborted();
        directories.add(results.directory);
        for (const path of results.files) files.add(path);
      }
      return { source, accountingSource: { rootPath: root,
        resourceKey: `fx:transcripts:${createHash('sha256').update(root).digest('base64url')}`,
        changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [...files], topologyDirectories: [...directories] } } };
    }),
    listCandidates: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new FxSourceError('invalid_request');
      return listFxCandidates(fxSessionsRoot(request.source, env()), request);
    }),
    resolveLinkIdentity: identity,
    resolveLinkedIdentity: identity,
    pageTranscript: request => guarded(request, async () => {
      if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1) throw new FxSourceError('invalid_request');
      const root = fxSessionsRoot(request.source, env());
      const projection = await readFxTranscript(root, request.remoteSessionId, request.signal);
      const prior = request.cursor ? decode(request.cursor) : null;
      if (prior && (prior.root !== root || prior.id !== request.remoteSessionId || prior.identity !== projection.identity
        || prior.count > projection.items.length || prior.prefix !== fxPrefix(projection.items, prior.count))) throw new FxSourceError('source_invalid');
      const count = prior?.count ?? projection.items.length;
      const bound = prior?.position ?? (request.direction === 'older' ? count : 0);
      const base: Cursor = { v: 1, root, id: request.remoteSessionId, identity: projection.identity,
        count, position: count, prefix: fxPrefix(projection.items, count) };
      const items: AgentExternalSessionsTranscriptPage['items'][number][] = [];
      let position = bound;
      while (items.length < request.maxItems && (request.direction === 'older' ? position > 0 : position < count)) {
        const index = request.direction === 'older' ? position - 1 : position;
        const nextItems = request.direction === 'older' ? [projection.items[index]!.item, ...items] : [...items, projection.items[index]!.item];
        const nextPosition = position + (request.direction === 'older' ? -1 : 1);
        const trial = { ok: true as const, value: { items: nextItems,
          nextCursor: encode({ ...base, position: nextPosition }), tailCursor: encode(base), hasMore: true, truncated: projection.partial } };
        if (!isAgentExternalSessionsResultWithinByteBudget(trial, request.maxSerializedBytes)) {
          if (!items.length) throw new FxSourceError('agent_error');
          break;
        }
        items.splice(0, items.length, ...nextItems);
        position = nextPosition;
      }
      const hasMore = request.direction === 'older' ? position > 0 : position < count;
      return { items, nextCursor: hasMore ? encode({ ...base, position }) : null,
        tailCursor: encode(base), hasMore, truncated: projection.partial };
    }),
    readAfterTranscript: request => guarded(request, async () => {
      const root = fxSessionsRoot(request.source, env());
      const prior = decode(request.cursor);
      if (prior.root !== root || prior.id !== request.remoteSessionId) throw new FxSourceError('invalid_request');
      let projection: Awaited<ReturnType<typeof readFxTranscript>>;
      try { projection = await readFxTranscript(root, request.remoteSessionId, request.signal); }
      catch (error) {
        if (fxFailureCode(error) === 'candidate_not_found') return { outcome: 'source_unavailable' as const };
        throw error;
      }
      if (prior.identity !== projection.identity) return { outcome: 'source_replaced' as const };
      if (prior.count > projection.items.length || prior.prefix !== fxPrefix(projection.items, prior.count)) {
        return { outcome: 'gap_or_cursor_expired' as const };
      }
      if (projection.partial) return { outcome: 'read_failed' as const };
      if (prior.count === projection.items.length) return { outcome: 'already_current' as const };
      let count = prior.count;
      const items: AgentExternalSessionsTranscriptPage['items'][number][] = [];
      while (count < projection.items.length && items.length < request.maxItems) {
        const nextItems = [...items, projection.items[count]!.item];
        const nextCursor = encode({ ...prior, count: count + 1, position: count + 1, prefix: fxPrefix(projection.items, count + 1) });
        if (!isAgentExternalSessionsResultWithinByteBudget({ ok: true, value: { outcome: 'advanced', items: nextItems,
          nextCursor, boundary: projection.identity, hasMore: true } }, request.maxSerializedBytes)) {
          if (!items.length) throw new FxSourceError('agent_error');
          break;
        }
        items.push(projection.items[count]!.item);
        count++;
      }
      return { outcome: 'advanced' as const, items, nextCursor: encode({ ...prior, count, position: count,
        prefix: fxPrefix(projection.items, count) }), boundary: projection.identity, hasMore: count < projection.items.length };
    }),
  };
}

export const fxExternalSessionsContribution: AgentExternalSessionsContribution = createFxExternalSessionsContribution();
