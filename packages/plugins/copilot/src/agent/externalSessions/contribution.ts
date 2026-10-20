import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { stat } from 'node:fs/promises';

import { isRecord } from '@happier-dev/plugin-sdk';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent, type ExternalSessionContentSearchControl } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { createAgentExternalSessionsProducerOverflowFailure, getAgentExternalSessionsInvocationFailure, isAgentExternalSessionsFailureCode, isAgentExternalSessionsResultWithinByteBudget } from '@happier-dev/plugin-sdk/sessions/external';
import type { AgentExternalSessionCandidate, AgentExternalSessionsContribution, AgentExternalSessionsInvocation, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';

import { discoverCopilotSessions, resolveCopilotSessionFile, resolveCopilotSource } from './source.js';
import { copilotItemText, isCopilotUnsupported, pageCopilotTranscript, readAfterCopilotTranscript, readCopilotHeader } from './transcript.js';

type CandidateCursor = { v: 1; root: string; inventory: string; query: string; target: string; index: number; transcript?: string; ordinal: number; partial: boolean };
function encode(cursor: CandidateCursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decode(raw: string): CandidateCursor {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString()); }
  catch { throw new Error('invalid_request'); }
  if (!isRecord(value) || value.v !== 1 || typeof value.root !== 'string' || typeof value.inventory !== 'string'
    || typeof value.query !== 'string' || typeof value.target !== 'string' || typeof value.partial !== 'boolean'
    || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0
    || typeof value.ordinal !== 'number' || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0
    || (value.transcript !== undefined && typeof value.transcript !== 'string')) throw new Error('invalid_request');
  return { v: 1, root: value.root, inventory: value.inventory, query: value.query, target: value.target,
    index: value.index, ordinal: value.ordinal, partial: value.partial, ...(typeof value.transcript === 'string' ? { transcript: value.transcript } : {}) };
}
function bounded<T>(value: T, request: AgentExternalSessionsInvocation): AgentExternalSessionsResult<T> {
  const result = { ok: true as const, value };
  return isAgentExternalSessionsResultWithinByteBudget(result, request.maxSerializedBytes)
    ? result : createAgentExternalSessionsProducerOverflowFailure('Copilot history exceeds the requested result byte budget.');
}
function failure(error: unknown, request: AgentExternalSessionsInvocation): AgentExternalSessionsResult<never> {
  const stopped = getAgentExternalSessionsInvocationFailure(request);
  if (stopped) return stopped;
  const token = error instanceof Error ? error.message : '';
  if (isAgentExternalSessionsFailureCode(token)) return { ok: false, code: token };
  if (isRecord(error) && error.code === 'ENOENT') return { ok: false, code: 'unavailable', retryable: true };
  if (isRecord(error) && (error.code === 'EACCES' || error.code === 'EPERM')) return { ok: false, code: 'not_authorized' };
  return { ok: false, code: 'agent_error', message: 'Copilot native history could not be read.' };
}

async function searchPage(params: { file: string; remoteSessionId: string; request: AgentExternalSessionsListCandidatesRequest; cursor: CandidateCursor; control: ExternalSessionContentSearchControl }) {
  let complete = true;
  const result = await searchExternalSessionContent({ query: params.cursor.query, control: params.control, isScanComplete: () => true,
    // The first page uses the host prefilter. Continuations already admitted the
    // file; repeating rg would rescan the whole log on every native page.
    ...(params.cursor.transcript ? {} : { paths: [params.file], ripgrep: params.request.ripgrep }),
    decode: async matchText => {
      const page = await pageCopilotTranscript(params.file, { ...params.request, remoteSessionId: params.remoteSessionId,
        direction: 'newer', cursor: params.cursor.transcript });
      const records = page.items.map((item, index) => {
        const text = copilotItemText(item);
        const snippet = text === null || isCopilotUnsupported(item) ? null : matchText(text);
        return { id: item.id, messageIndex: params.cursor.ordinal + index, ...(snippet === null ? {} : { snippet }) };
      });
      params.cursor.ordinal += page.items.length;
      params.cursor.transcript = page.nextCursor ?? undefined;
      complete = page.nextCursor === null;
      return { partial: Boolean(page.diagnostics?.length || page.items.some(isCopilotUnsupported)), records };
    },
  });
  params.cursor.partial ||= result.partial;
  return { result, complete };
}

export function createCopilotExternalSessionsContribution(options: { env?: NodeJS.ProcessEnv } = {}): AgentExternalSessionsContribution {
  const readEnv = () => options.env ?? process.env;
  const resolveIdentity: AgentExternalSessionsContribution['resolveLinkIdentity'] = async request => {
    const stopped = getAgentExternalSessionsInvocationFailure(request);
    if (stopped) return stopped;
    try {
      const resolved = await resolveCopilotSource(request.source, readEnv());
      const file = await resolveCopilotSessionFile(resolved.root, request.remoteSessionId);
      const header = await readCopilotHeader(file, request.remoteSessionId, request.signal);
      if (!header.supported) return { ok: false, code: 'unsupported' };
      return bounded({ source: resolved.source, remoteSessionId: request.remoteSessionId,
        linkData: { copilotSessionId: request.remoteSessionId } }, request);
    } catch (error) { return failure(error, request); }
  };
  return {
    async resolveSource(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      try {
        const resolved = await resolveCopilotSource(request.source, readEnv());
        if (request.includeAccountingSource === false) return bounded({ source: resolved.source }, request);
        const inventory = await discoverCopilotSessions(resolved.root, request.signal);
        return bounded({ source: resolved.source, accountingSource: {
          rootPath: resolved.home, rootField: 'homeDir', resourceKey: `copilot-events:${resolved.root}`,
          changeObservation: 'watch_file_changes' as const,
          watchFileChanges: { files: inventory.files, topologyDirectories: inventory.topologyDirectories },
          discoveredFileCount: inventory.files.length,
        } }, request);
      } catch (error) { return failure(error, request); }
    },
    async listCandidates(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      try {
        const resolved = await resolveCopilotSource(request.source, readEnv());
        const inventory = await discoverCopilotSessions(resolved.root, request.signal);
        if (!inventory.available) return { ok: false, code: 'unavailable', retryable: true };
        const inventoryKey = createHash('sha256').update(JSON.stringify(inventory.files)).digest('base64url');
        const query = request.searchTerm ?? '';
        const target = request.searchTarget ?? 'metadata';
        const cursor = request.cursor ? decode(request.cursor)
          : { v: 1 as const, root: resolved.root, inventory: inventoryKey, query, target, index: 0, ordinal: 0, partial: false };
        if (cursor.root !== resolved.root || cursor.query !== query || cursor.target !== target || cursor.inventory !== inventoryKey) throw new Error('source_invalid');
        const candidates: AgentExternalSessionCandidate[] = [];
        const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
        try {
          await control.prepare(async () => {
            if (cursor.index >= inventory.files.length || candidates.length >= request.maxItems) return true;
            const remoteSessionId = basename(dirname(inventory.files[cursor.index]!));
            const file = await resolveCopilotSessionFile(resolved.root, remoteSessionId);
            const metadata = await stat(file);
            const header = await readCopilotHeader(file, remoteSessionId, request.signal);
            const candidate = { remoteSessionId, title: remoteSessionId, updatedAtMs: metadata.mtimeMs, createdAtMs: metadata.birthtimeMs,
              ...(header.cwd ? { cwd: header.cwd } : {}),
              linkData: { copilotSessionId: remoteSessionId } };
            if (!header.supported) cursor.partial = true;
            else if (target === 'content' && query) {
              const searched = await searchPage({ file, remoteSessionId, request, cursor, control });
              if (searched.result.match) candidates.push({ ...candidate, match: searched.result.match });
              if (!searched.result.match && !searched.complete) return false;
            } else if (!query || remoteSessionId.toLowerCase().includes(query.toLowerCase())) {
              candidates.push(candidate);
            }
            cursor.index += 1; cursor.ordinal = 0; delete cursor.transcript;
            return cursor.index >= inventory.files.length || candidates.length >= request.maxItems;
          });
        } catch (error) { if (!(error instanceof ExternalSessionContentSearchYield)) throw error; }
        const nextCursor = cursor.index < inventory.files.length ? encode(cursor) : null;
        return bounded({ candidates, nextCursor,
          ...(target === 'content' ? { contentCoverage: nextCursor || cursor.partial ? 'partial' as const : 'complete' as const } : {}),
          ...(cursor.partial || nextCursor ? { searchIncomplete: true } : {}) }, request);
      } catch (error) { return failure(error, request); }
    },
    resolveLinkIdentity: resolveIdentity,
    resolveLinkedIdentity: resolveIdentity,
    async pageTranscript(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      try {
        const resolved = await resolveCopilotSource(request.source, readEnv());
        const file = await resolveCopilotSessionFile(resolved.root, request.remoteSessionId);
        return bounded(await pageCopilotTranscript(file, request), request);
      } catch (error) {
        if (error instanceof Error && error.message === 'source_replaced') return { ok: false, code: 'source_invalid' };
        return failure(error, request);
      }
    },
    async readAfterTranscript(request) {
      const stopped = getAgentExternalSessionsInvocationFailure(request);
      if (stopped) return stopped;
      try {
        const resolved = await resolveCopilotSource(request.source, readEnv());
        const file = await resolveCopilotSessionFile(resolved.root, request.remoteSessionId);
        return bounded(await readAfterCopilotTranscript(file, request), request);
      } catch (error) {
        if (error instanceof Error && error.message === 'source_replaced') return bounded({ outcome: 'source_replaced' as const }, request);
        if (isRecord(error) && error.code === 'ENOENT') return bounded({ outcome: 'source_unavailable' as const }, request);
        return failure(error, request);
      }
    },
  };
}

export const copilotExternalSessionsContribution = createCopilotExternalSessionsContribution();
