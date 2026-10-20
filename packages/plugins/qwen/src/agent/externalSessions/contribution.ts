import { createHash } from 'node:crypto';
import type { AgentExternalSessionTranscriptItem, AgentExternalSessionsContribution, AgentExternalSessionsInvocation,
  AgentExternalSessionsPageTranscriptRequest, AgentExternalSessionsResult, AgentExternalSessionsTranscriptPage } from '@happier-dev/plugin-sdk/sessions/external';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { join } from 'node:path';
import { decode, encode, listQwenCandidates } from './candidates.js';
import { listQwenFiles, QwenSourceError, resolveQwenSource, validSessionId, validateQwenHistoryRoot, type QwenSource } from './source.js';
import { digestItems, readQwenTranscript, type QwenTranscript } from './transcript.js';

type Cursor = { v: 1; source: string; sessionId: string; identity: string; count: number; digest: string; position: number };
function makeCursor(source: QwenSource, sessionId: string, transcript: QwenTranscript, position: number, count = position): string {
  return encode({ v: 1, source: source.runtimeDir, sessionId, identity: transcript.identity, count,
    digest: digestItems(transcript.items.slice(0, count)), position });
}
function parseCursor(raw: string, source: QwenSource, sessionId: string): Cursor {
  const value = decode(raw);
  if (value.v !== 1 || value.source !== source.runtimeDir || value.sessionId !== sessionId || typeof value.identity !== 'string' || typeof value.digest !== 'string'
    || !Number.isSafeInteger(value.count) || Number(value.count) < 0 || !Number.isSafeInteger(value.position) || Number(value.position) < 0
    || Number(value.position) > Number(value.count)) throw new QwenSourceError('invalid_request', 'Qwen transcript cursor is invalid.');
  return { v: 1, source: value.source, sessionId, identity: value.identity, count: Number(value.count), digest: value.digest, position: Number(value.position) };
}
function samePrefix(cursor: Cursor, transcript: QwenTranscript): boolean {
  return cursor.identity === transcript.identity && cursor.count <= transcript.items.length && cursor.digest === digestItems(transcript.items.slice(0, cursor.count));
}
async function readSession(source: QwenSource, sessionId: string, signal: AbortSignal): Promise<QwenTranscript> {
  if (!validSessionId(sessionId)) throw new QwenSourceError('invalid_request', 'Qwen session ID is invalid.');
  const matches = (await listQwenFiles(source, signal)).filter(file => file.sessionId === sessionId);
  if (!matches.length) throw new QwenSourceError('candidate_not_found', 'Qwen transcript is absent from its available history store.');
  if (matches.length > 1) throw new QwenSourceError('source_invalid', 'Qwen session identity is ambiguous.');
  return readQwenTranscript(matches[0]!, signal);
}
function limitCheck(request: Readonly<{ maxItems: number; maxSerializedBytes: number }>): void {
  if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1 || !Number.isSafeInteger(request.maxSerializedBytes) || request.maxSerializedBytes < 1)
    throw new QwenSourceError('invalid_request', 'Qwen page budgets must be positive integers.');
}
function ensureFits(value: AgentExternalSessionsResult<unknown>, budget: number): void {
  if (!isAgentExternalSessionsResultWithinByteBudget(value, budget)) throw new QwenSourceError('agent_error', 'Qwen transcript item exceeds the caller result budget.');
}
function page(source: QwenSource, transcript: QwenTranscript, request: AgentExternalSessionsPageTranscriptRequest): AgentExternalSessionsTranscriptPage {
  const cursor = request.cursor ? parseCursor(request.cursor, source, request.remoteSessionId) : null;
  if (cursor && !samePrefix(cursor, transcript)) throw new QwenSourceError('source_invalid', 'Qwen transcript changed before paging.');
  const older = request.direction === 'older';
  const count = cursor?.count ?? transcript.items.length;
  const position = cursor?.position ?? (older ? count : 0);
  const items: AgentExternalSessionTranscriptItem[] = [];
  let next = position;
  const build = (): AgentExternalSessionsTranscriptPage => {
    const hasMore = older ? next > 0 : next < transcript.items.length;
    return { items, hasMore, nextCursor: hasMore ? makeCursor(source, request.remoteSessionId, transcript, next, older ? count : next) : null,
      tailCursor: makeCursor(source, request.remoteSessionId, transcript, older ? count : next), ...(transcript.partial ? { truncated: true } : {}) };
  };
  while (items.length < request.maxItems && (older ? next > 0 : next < transcript.items.length)) {
    const candidate = transcript.items[older ? next - 1 : next]!;
    if (older) items.unshift(candidate); else items.push(candidate);
    next += older ? -1 : 1;
    if (!isAgentExternalSessionsResultWithinByteBudget({ ok: true, value: build() }, request.maxSerializedBytes)) {
      if (items.length === 1) ensureFits({ ok: true, value: build() }, request.maxSerializedBytes);
      if (older) items.shift(); else items.pop(); next += older ? 1 : -1; break;
    }
  }
  const result = build(); ensureFits({ ok: true, value: result }, request.maxSerializedBytes); return result;
}

export function createQwenExternalSessionsContribution(params: Readonly<{ env?: NodeJS.ProcessEnv }> = {}): AgentExternalSessionsContribution {
  const resolve = (source: Parameters<typeof resolveQwenSource>[0]) => resolveQwenSource(source, params.env ?? process.env);
  const run = async <T>(request: AgentExternalSessionsInvocation, action: () => Promise<T>): Promise<AgentExternalSessionsResult<T>> => {
    const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
    try {
      const value = await action(); const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
      const result = { ok: true as const, value };
      return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)
        ? result : createAgentExternalSessionsProducerOverflowFailure('Qwen result exceeds the caller byte budget.');
    } catch (error) {
      const stopped = getAgentExternalSessionsInvocationFailure(request); if (stopped) return stopped;
      if (error instanceof QwenSourceError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: 'agent_error', message: 'Qwen history could not be read.', retryable: true };
    }
  };
  const contribution: AgentExternalSessionsContribution = {
    resolveSource: request => run(request, async () => {
      const source = resolve(request.source);
      if (request.includeAccountingSource === false) return { source: source.source };
      await validateQwenHistoryRoot(source);
      const inventory = await discoverAgentAccountingJsonlSource([join(source.runtimeDir, 'projects')], request.signal);
      return { source: source.source, accountingSource: { rootPath: source.runtimeDir, rootField: 'runtimeDir',
        resourceKey: `qwen:transcripts:${createHash('sha256').update(source.runtimeDir).digest('base64url')}`,
        changeObservation: 'watch_file_changes' as const,
        watchFileChanges: { files: [...inventory.files], topologyDirectories: [source.runtimeDir, ...inventory.topologyDirectories] } } };
    }),
    listCandidates: request => run(request, async () => { limitCheck(request); return listQwenCandidates(resolve(request.source), request); }),
    resolveLinkIdentity: request => run(request, async () => {
      const source = resolve(request.source); await readSession(source, request.remoteSessionId, request.signal);
      return { source: source.source, remoteSessionId: request.remoteSessionId, linkData: {} };
    }),
    resolveLinkedIdentity: request => run(request, async () => {
      const source = resolve(request.source); await readSession(source, request.remoteSessionId, request.signal);
      return { source: source.source, remoteSessionId: request.remoteSessionId, linkData: {} };
    }),
    pageTranscript: request => run(request, async () => {
      limitCheck(request); const source = resolve(request.source);
      return page(source, await readSession(source, request.remoteSessionId, request.signal), request);
    }),
    readAfterTranscript: request => run(request, async () => {
      limitCheck(request); const source = resolve(request.source);
      const cursor = parseCursor(request.cursor, source, request.remoteSessionId);
      let transcript: QwenTranscript;
      try { transcript = await readSession(source, request.remoteSessionId, request.signal); }
      catch (error) {
        if (error instanceof QwenSourceError && error.code === 'candidate_not_found') return { outcome: 'source_unavailable' as const };
        throw error;
      }
      if (!samePrefix(cursor, transcript)) return { outcome: 'source_replaced' as const };
      if (cursor.position === transcript.items.length) return { outcome: 'already_current' as const };
      const next = page(source, transcript, { ...request, direction: 'newer' });
      return { outcome: 'advanced' as const, items: next.items, nextCursor: next.tailCursor!, boundary: transcript.identity, hasMore: next.hasMore === true };
    }),
  };
  return Object.freeze(contribution);
}
export const qwenExternalSessionsContribution: AgentExternalSessionsContribution = createQwenExternalSessionsContribution();
