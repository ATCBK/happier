import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { createExternalSessionContentSearchControl, ExternalSessionContentSearchYield, searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { ExternalSessionContentSearchPageProgress } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionCandidate, AgentExternalSessionsListCandidatesRequest, AgentExternalSessionsListCandidatesResult } from '@happier-dev/plugin-sdk/sessions/external';
import { CodeBuddySourceError, discoverCodeBuddyFiles, isRecord, resolveCodeBuddySource } from './source.js';
import { pageCodeBuddyTranscript } from './transcript.js';

type SearchCursor = { v: 1; root: string; query: string; target: string; after: string; partial?: boolean; file?: string; progress?: ExternalSessionContentSearchPageProgress };
const encode = (value: SearchCursor) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(raw: string): SearchCursor {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString()); } catch { throw new CodeBuddySourceError('invalid_request', 'Invalid CodeBuddy search cursor.'); }
  if (!isRecord(value) || value.v !== 1 || typeof value.root !== 'string' || typeof value.query !== 'string' || typeof value.target !== 'string' || typeof value.after !== 'string'
    || (value.file !== undefined && typeof value.file !== 'string') || (value.partial !== undefined && typeof value.partial !== 'boolean')) throw new CodeBuddySourceError('invalid_request', 'Invalid CodeBuddy search cursor.');
  let progress: ExternalSessionContentSearchPageProgress | undefined;
  if (value.progress !== undefined) {
    const p = value.progress;
    if (!isRecord(p) || typeof p.complete !== 'boolean' || typeof p.itemCount !== 'number' || !Number.isSafeInteger(p.itemCount) || p.itemCount < 0
      || (p.cursor !== undefined && typeof p.cursor !== 'string')) throw new CodeBuddySourceError('invalid_request', 'Invalid CodeBuddy search progress.');
    let match: ExternalSessionContentSearchPageProgress['match'] = null;
    if (p.match !== null) {
      const m = p.match;
      if (!isRecord(m) || typeof m.id !== 'string' || typeof m.distanceFromEnd !== 'number' || !Number.isSafeInteger(m.distanceFromEnd) || m.distanceFromEnd < 1 || m.distanceFromEnd > p.itemCount
        || (m.cursor !== undefined && typeof m.cursor !== 'string')) throw new CodeBuddySourceError('invalid_request', 'Invalid CodeBuddy search match.');
      match = { id: m.id, distanceFromEnd: m.distanceFromEnd, ...(typeof m.cursor === 'string' ? { cursor: m.cursor } : {}) };
    }
    progress = { complete: p.complete, itemCount: p.itemCount, match, ...(typeof p.cursor === 'string' ? { cursor: p.cursor } : {}) };
  }
  return { v: 1, root: value.root, query: value.query, target: value.target, after: value.after, ...(value.partial === true ? { partial: true } : {}), ...(typeof value.file === 'string' ? { file: value.file } : {}), ...(progress ? { progress } : {}) };
}
function visibleText(item: Awaited<ReturnType<typeof pageCodeBuddyTranscript>>['items'][number]): string | null {
  const content: unknown = item.raw.content;
  if (item.id.endsWith(':unsupported')) return null;
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') return content.text;
  if (isRecord(content) && content.type === 'acp' && isRecord(content.data)) {
    if (typeof content.data.message === 'string') return content.data.message;
    if (typeof content.data.output === 'string') return content.data.output;
  }
  return null;
}
export async function listCodeBuddyCandidates(request: AgentExternalSessionsListCandidatesRequest, env: NodeJS.ProcessEnv): Promise<AgentExternalSessionsListCandidatesResult> {
  const resolved = await resolveCodeBuddySource(request.source, env);
  const query = request.searchTerm ?? '';
  const target = request.searchTarget ?? 'metadata';
  const prior = request.cursor ? decode(request.cursor) : null;
  if (prior && (prior.root !== resolved.root || prior.query !== query || prior.target !== target)) throw new CodeBuddySourceError('invalid_request', 'CodeBuddy cursor does not match this source and query.');
  const files = (await discoverCodeBuddyFiles(resolved.root, request.signal)).files;
  const candidates: AgentExternalSessionCandidate[] = [];
  const control = createExternalSessionContentSearchControl({ signal: request.signal, deadlineAtMs: request.scanDeadlineAtMs ?? request.deadlineAtMs });
  let after = prior?.after ?? '';
  let partial = prior?.partial ?? false;
  let nextCursor: string | null = null;
  let bytes = 0;
  for (const file of files) {
    if (file <= after) continue;
    const progress: ExternalSessionContentSearchPageProgress = prior?.file === file && prior.progress ? { ...prior.progress } : { complete: false, itemCount: 0, match: null };
    const continuation = () => encode({ v: 1, root: resolved.root, query, target, after, partial, file, progress });
    const info = await stat(file);
    let candidate: AgentExternalSessionCandidate = { remoteSessionId: basename(file, '.jsonl'), updatedAtMs: info.mtimeMs, linkData: { sessionFile: file } };
    try {
      if (target === 'content') {
        control.checkWork();
        const result = await searchExternalSessionContent({ query, control, pageProgress: progress,
          // The helper owns decoding/matching; rg is only an optional prefilter.
          decode: async (matchText, cursor) => {
            // The outer maxItems counts Sessions, not native messages. Native
            // batches use the containing byte allowance, so a one-hit query
            // does not reread/hash a whole source for every individual row.
            const page = await pageCodeBuddyTranscript({ file, cursor, maxItems: Number.MAX_SAFE_INTEGER, maxSerializedBytes: request.maxSerializedBytes, signal: request.signal });
            partial ||= page.partial;
            candidate = { ...candidate, ...(page.title ? { title: page.title } : {}), ...(page.cwd ? { cwd: page.cwd } : {}) };
            return { records: page.items.map(item => { const text = visibleText(item); const snippet = text === null ? null : matchText(text); return { id: item.id, ...(snippet === null ? {} : { snippet }) }; }), partial: false, nextCursor: page.nextCursor };
          } });
        partial ||= result.partial;
        if (!result.match) { after = file; continue; }
        candidate = { ...candidate, match: result.match };
      } else {
        const page = await pageCodeBuddyTranscript({ file, maxItems: request.maxItems, maxSerializedBytes: request.maxSerializedBytes, signal: request.signal });
        candidate = { ...candidate, ...(page.title ? { title: page.title } : {}), ...(page.cwd ? { cwd: page.cwd } : {}) };
        if (query && !`${candidate.title ?? ''} ${candidate.remoteSessionId}`.toLowerCase().includes(query.toLowerCase())) { after = file; continue; }
      }
    } catch (error) {
      if (!(error instanceof ExternalSessionContentSearchYield)) throw error;
      nextCursor = continuation(); partial = true; break;
    }
    const size = Buffer.byteLength(JSON.stringify(candidate));
    if (candidates.length > 0 && bytes + size > request.maxSerializedBytes) { nextCursor = continuation(); break; }
    if (size > request.maxSerializedBytes) throw new CodeBuddySourceError('invalid_request', 'CodeBuddy candidate exceeds the supplied result allowance.');
    candidates.push(candidate); bytes += size; after = file;
    if (candidates.length >= request.maxItems) { if (files.some(next => next > after)) nextCursor = encode({ v: 1, root: resolved.root, query, target, after, partial }); break; }
  }
  return { candidates, nextCursor, ...(target === 'content' ? { contentCoverage: partial || nextCursor ? 'partial' : 'complete' } : {}) };
}
