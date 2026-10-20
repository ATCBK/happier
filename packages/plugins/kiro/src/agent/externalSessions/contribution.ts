import { join } from 'node:path';
import type {
  AgentExternalSessionCandidate, AgentExternalSessionsContribution,
  AgentExternalSessionsFailureCode, AgentExternalSessionsInvocation, AgentExternalSessionsResult,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import {
  createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isRecord, parseTimestampMs } from '@happier-dev/plugin-sdk';
import { digest, KiroSourceError, listKiroMetadata, readKiroMetadata, resolveKiroChatSource } from './source.js';
import { kiroPrefixIdentity, readKiroTranscript, type KiroTranscript } from './transcript.js';

function ok<T>(value: T): AgentExternalSessionsResult<T> { return { ok: true, value }; }
function fail(code: AgentExternalSessionsFailureCode, message: string): AgentExternalSessionsResult<never> { return { ok: false, code, message }; }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(text: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString()); return isRecord(parsed) ? parsed : null; }
  catch { return null; }
}
function positiveInteger(value: number) { return Number.isSafeInteger(value) && value > 0; }
class KiroReplyOverflow extends Error {}
function cursorFor(snapshot: KiroTranscript, root: string, id: string, end: number) {
  return encode({ v: 1, source: digest(root), id, end, prefix: kiroPrefixIdentity(snapshot, end) });
}
function parseTranscriptCursor(cursor: string | undefined, snapshot: KiroTranscript, root: string, id: string) {
  const parsed = cursor ? decode(cursor) : null;
  if (!parsed || parsed.v !== 1 || parsed.source !== digest(root) || parsed.id !== id
    || typeof parsed.end !== 'number' || !Number.isSafeInteger(parsed.end) || parsed.end < 0
    || parsed.end > snapshot.rows.length || parsed.prefix !== kiroPrefixIdentity(snapshot, parsed.end)) return null;
  return parsed.end;
}

type ReadAfterTranscriptValue = Awaited<ReturnType<AgentExternalSessionsContribution['readAfterTranscript']>> extends AgentExternalSessionsResult<infer V> ? V : never;

export function createKiroExternalSessionsContribution(options: Readonly<{ env?: NodeJS.ProcessEnv }> = {}): AgentExternalSessionsContribution {
  const resolve = (source: Parameters<AgentExternalSessionsContribution['resolveSource']>[0]['source']) => resolveKiroChatSource(source, options.env ?? process.env);
  async function guarded<T>(request: AgentExternalSessionsInvocation, work: () => Promise<AgentExternalSessionsResult<T>>): Promise<AgentExternalSessionsResult<T>> {
    const stopped = getAgentExternalSessionsInvocationFailure(request);
    if (stopped) return stopped;
    try {
      const result = await work();
      const finished = getAgentExternalSessionsInvocationFailure(request);
      if (finished) return finished;
      return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes) ? result : fail('agent_error', 'Kiro native result exceeds the caller byte allowance.');
    } catch (error) {
      const finished = getAgentExternalSessionsInvocationFailure(request);
      if (finished) return finished;
      return error instanceof KiroSourceError ? fail(error.code, error.message)
        : error instanceof KiroReplyOverflow ? fail('agent_error', error.message)
          : fail('unavailable', 'Kiro native history could not be read.');
    }
  }
  const identity: AgentExternalSessionsContribution['resolveLinkIdentity'] = request => guarded(request, async () => {
    const source = await resolve(request.source);
    await readKiroMetadata(source.root, request.remoteSessionId, request.signal);
    return ok({ source: source.source, remoteSessionId: request.remoteSessionId, linkData: {} });
  });
  return {
    resolveSource: request => guarded(request, async () => {
      const source = await resolve(request.source);
      if (request.includeAccountingSource === false) return ok({ source: source.source });
      let ids: string[];
      try { ids = await listKiroMetadata(source.root, request.signal); }
      catch (error) {
        // Admission can describe an absent native store; discovery/listing still
        // reports unavailability, and topology can notice its creation later.
        if (!(error instanceof KiroSourceError) || error.code !== 'unavailable') throw error;
        ids = [];
      }
      return ok({ source: source.source, accountingSource: {
        rootPath: source.root, resourceKey: `kiro:chat-v1:${digest(source.root)}`, changeObservation: 'watch_file_changes',
        watchFileChanges: { files: ids.flatMap(id => [join(source.root, `${id}.json`), join(source.root, `${id}.jsonl`)]), topologyDirectories: [source.root] },
      } });
    }),
    listCandidates: request => guarded(request, async () => {
      if (!positiveInteger(request.maxItems)) return fail('invalid_request', 'Kiro candidate count must be positive.');
      const source = await resolve(request.source);
      const ids = await listKiroMetadata(source.root, request.signal);
      const binding = digest(JSON.stringify([source.root, request.searchTarget ?? 'metadata', request.searchTerm ?? '', request.includeThreads === true]));
      const previous = request.cursor ? decode(request.cursor) : null;
      if (request.cursor && (!previous || previous.v !== 1 || previous.binding !== binding || typeof previous.after !== 'string')) return fail('invalid_request', 'Kiro candidate cursor does not match this source and query.');
      let position = previous ? ids.findIndex(id => id > String(previous.after)) : 0;
      if (position < 0) position = ids.length;
      const candidates: AgentExternalSessionCandidate[] = [];
      let partial = false;
      const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs });
      let after = previous ? String(previous.after) : '';
      const nextCursor = () => position < ids.length ? encode({ v: 1, binding, after }) : null;
      try {
        await control.prepare(async () => {
          if (position >= ids.length) return true;
          const id = ids[position]!;
          try {
            const metadata = await readKiroMetadata(source.root, id, request.signal);
            const parent = metadata.record.parent_session_id;
            if (!parent || request.includeThreads) {
              const candidate: AgentExternalSessionCandidate = {
                remoteSessionId: id,
                ...(typeof metadata.record.title === 'string' ? { title: metadata.record.title } : {}),
                ...(typeof metadata.record.cwd === 'string' ? { cwd: metadata.record.cwd } : {}),
                updatedAtMs: parseTimestampMs(metadata.record.updated_at) ?? parseTimestampMs(metadata.record.created_at) ?? 0,
                ...(typeof parent === 'string' && parent ? { thread: { kind: 'subagent', parentRemoteSessionId: parent } } : {}),
              };
              let matched: AgentExternalSessionCandidate | null = candidate;
              if (request.searchTarget === 'content') {
                const projection = await readKiroTranscript(source.root, id, request.signal);
                const result = await searchExternalSessionContent({
                  query: request.searchTerm ?? '', control, isScanComplete: () => true,
                  decode: async matchText => ({ partial: projection.partial, records: projection.rows.map((row, messageIndex) => {
                    const snippet = row.text ? matchText(row.text) : null;
                    return { id: row.item.id, messageIndex, ...(snippet !== null ? { snippet } : {}) };
                  }) }),
                });
                partial ||= result.partial;
                matched = result.match ? { ...candidate, match: result.match } : null;
              } else if (request.searchTerm && !`${candidate.title ?? ''}\n${candidate.cwd ?? ''}\n${id}`.toLowerCase().includes(request.searchTerm.toLowerCase())) matched = null;
              if (matched) {
                const proposed = [...candidates, matched];
                const cursor = position + 1 < ids.length ? encode({ v: 1, binding, after: id }) : null;
                if (!isAgentExternalSessionsResultWithinByteBudget(ok({ candidates: proposed, nextCursor: cursor, contentCoverage: 'partial' }), request.maxSerializedBytes)) {
                  if (candidates.length === 0) throw new KiroReplyOverflow('One Kiro candidate exceeds the caller byte allowance.');
                  return true;
                }
                candidates.push(matched);
              }
            }
          } catch (error) {
            request.signal.throwIfAborted();
            if (!(error instanceof KiroSourceError)) throw error;
            partial = true;
          }
          after = id; position += 1;
          return position >= ids.length || candidates.length >= request.maxItems;
        });
      } catch (error) {
        if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
        partial = true;
      }
      const cursor = nextCursor();
      return ok({ candidates, nextCursor: cursor,
        ...(request.searchTarget === 'content' ? { contentCoverage: partial || cursor ? 'partial' as const : 'complete' as const } : {}),
        ...(partial ? { searchIncomplete: true } : {}),
      });
    }),
    resolveLinkIdentity: identity,
    resolveLinkedIdentity: identity,
    pageTranscript: request => guarded(request, async () => {
      if (!positiveInteger(request.maxItems)) return fail('invalid_request', 'Kiro transcript count must be positive.');
      const source = await resolve(request.source);
      const snapshot = await readKiroTranscript(source.root, request.remoteSessionId, request.signal);
      if (snapshot.missing) return fail('unavailable', 'Kiro native transcript has not been written.');
      const parsed = request.cursor ? parseTranscriptCursor(request.cursor, snapshot, source.root, request.remoteSessionId) : null;
      if (request.cursor && parsed === null) return fail('source_invalid', 'Kiro native transcript changed or its cursor is invalid.');
      const end = parsed ?? (request.direction === 'older' ? snapshot.rows.length : 0);
      let start = request.direction === 'older' ? Math.max(0, end - request.maxItems) : end;
      let finish = request.direction === 'older' ? end : Math.min(snapshot.rows.length, end + request.maxItems);
      const build = (): AgentExternalSessionsTranscriptPage => ({
        items: snapshot.rows.slice(start, finish).map(row => row.item),
        nextCursor: request.direction === 'older'
          ? start > 0 ? cursorFor(snapshot, source.root, request.remoteSessionId, start) : null
          : finish < snapshot.rows.length ? cursorFor(snapshot, source.root, request.remoteSessionId, finish) : null,
        tailCursor: cursorFor(snapshot, source.root, request.remoteSessionId, finish),
        hasMore: request.direction === 'older' ? start > 0 : finish < snapshot.rows.length,
        truncated: snapshot.partial,
      });
      while (!isAgentExternalSessionsResultWithinByteBudget(ok(build()), request.maxSerializedBytes) && finish > start) {
        if (request.direction === 'older') start += 1; else finish -= 1;
      }
      if (start === finish && snapshot.rows.length) return fail('agent_error', 'One Kiro transcript item exceeds the caller byte allowance.');
      return ok(build());
    }),
    readAfterTranscript: request => guarded<ReadAfterTranscriptValue>(request, async () => {
      if (!positiveInteger(request.maxItems)) return fail('invalid_request', 'Kiro transcript count must be positive.');
      const source = await resolve(request.source);
      let snapshot: KiroTranscript | null;
      try { snapshot = await readKiroTranscript(source.root, request.remoteSessionId, request.signal); }
      catch (error) {
        if (error instanceof KiroSourceError && error.code === 'candidate_not_found') snapshot = null;
        else throw error;
      }
      if (!snapshot || snapshot.missing) {
        // Missing files prove retirement only while their containing store is
        // available. Ordinary reads need no additional directory enumeration.
        await listKiroMetadata(source.root, request.signal);
        return ok({ outcome: 'source_unavailable' as const });
      }
      const start = parseTranscriptCursor(request.cursor, snapshot, source.root, request.remoteSessionId);
      if (start === null) return ok({ outcome: 'source_replaced' as const });
      if (start === snapshot.rows.length) return ok({ outcome: 'already_current' as const });
      let end = Math.min(start + request.maxItems, snapshot.rows.length);
      const build = () => ({ outcome: 'advanced' as const, items: snapshot.rows.slice(start, end).map(row => row.item),
        nextCursor: cursorFor(snapshot, source.root, request.remoteSessionId, end), boundary: digest(source.root), hasMore: end < snapshot.rows.length });
      while (end > start && !isAgentExternalSessionsResultWithinByteBudget(ok(build()), request.maxSerializedBytes)) end -= 1;
      if (end === start) return fail('agent_error', 'One Kiro transcript item exceeds the caller byte allowance.');
      return ok(build());
    }),
  };
}

export const kiroExternalSessionsContribution: AgentExternalSessionsContribution = createKiroExternalSessionsContribution();
