import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import type { AgentExternalSessionSource, AgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';

export class GrokSourceError extends Error {
  constructor(readonly code: AgentExternalSessionsFailureCode) { super(`Grok native history: ${code}`); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
export function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decode(raw: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString()); if (record(value)) return value; } catch { /* Typed admission below. */ }
  throw new GrokSourceError('source_invalid');
}
export function grokSessionsRoot(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv): string {
  if (source.kind !== 'grokHome' || Object.keys(source).some(key => key !== 'kind')) throw new GrokSourceError('source_invalid');
  const home = env.GROK_HOME || join(resolveHomeDirFromEnvironment(env), '.grok');
  if (!isAbsolute(home)) throw new GrokSourceError('source_invalid');
  return join(home, 'sessions');
}
export async function confinedPath(root: string, path: string): Promise<string> {
  const physicalRoot = await realpath(root);
  const physical = await realpath(path);
  if (physical !== physicalRoot && !isCanonicalAbsolutePathInsideRoot(physicalRoot, physical)) throw new GrokSourceError('source_invalid');
  return physical;
}
export function isSessionId(value: string): boolean { return /^[A-Za-z0-9_-]+$/.test(value); }
export type GrokSession = Readonly<{ id: string; dir: string }>;
/** Grok encodes cwd or uses a slug/hash for long cwd. The actual directory is
 * discovered; this reader does not duplicate the vendor's hash algorithm. */
export async function listGrokSessions(root: string, signal: AbortSignal): Promise<GrokSession[]> {
  const sessions: GrokSession[] = [];
  const seen = new Set<string>();
  for (const group of await readdir(await confinedPath(root, root), { withFileTypes: true })) {
    signal.throwIfAborted();
    if (group.isSymbolicLink()) throw new GrokSourceError('source_invalid');
    if (!group.isDirectory()) continue;
    const groupPath = await confinedPath(root, join(root, group.name));
    for (const session of await readdir(groupPath, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (session.isSymbolicLink()) throw new GrokSourceError('source_invalid');
      if (!session.isDirectory() || !isSessionId(session.name)) continue;
      if (seen.has(session.name)) throw new GrokSourceError('source_invalid');
      seen.add(session.name);
      sessions.push({ id: session.name, dir: await confinedPath(root, join(groupPath, session.name)) });
    }
  }
  return sessions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export async function findGrokSession(root: string, id: string, signal: AbortSignal): Promise<GrokSession> {
  if (!isSessionId(id)) throw new GrokSourceError('invalid_request');
  const session = (await listGrokSessions(root, signal)).find(item => item.id === id);
  if (!session) throw new GrokSourceError('candidate_not_found');
  return session;
}
export async function grokFile(root: string, session: GrokSession, name: 'summary.json' | 'chat_history.jsonl'): Promise<string> {
  const path = join(session.dir, name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new GrokSourceError('source_invalid');
  return confinedPath(root, path);
}
export async function readGrokSummary(root: string, session: GrokSession) {
  const summaryPath = await grokFile(root, session, 'summary.json');
  const bytes = await readFile(summaryPath);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); } catch { throw new GrokSourceError('unsupported'); }
  // The pinned upstream evidence is an unversioned dialect. An explicit future
  // version or semantic field is not silently interpreted as that dialect.
  const known = new Set(['info', 'generated_title', 'session_summary', 'current_model_id', 'head_branch',
    'num_chat_messages', 'num_messages', 'created_at', 'updated_at', 'last_active_at']);
  if (!record(value) || Object.keys(value).some(key => !known.has(key)) || !record(value.info)
    || value.info.id !== session.id || typeof value.info.cwd !== 'string'
    || Object.keys(value.info).some(key => key !== 'id' && key !== 'cwd')) throw new GrokSourceError('unsupported');
  const createdAtMs = parseTimestampMs(value.created_at);
  const updatedAtMs = parseTimestampMs(value.last_active_at) ?? parseTimestampMs(value.updated_at) ?? createdAtMs
    ?? Math.trunc((await lstat(summaryPath)).mtimeMs);
  return { cwd: value.info.cwd, createdAtMs, updatedAtMs,
    title: typeof value.generated_title === 'string' ? value.generated_title
      : typeof value.session_summary === 'string' ? value.session_summary : undefined };
}
export function grokFailureCode(error: unknown): AgentExternalSessionsFailureCode {
  if (error instanceof GrokSourceError) return error.code;
  if (record(error) && error.code === 'ENOENT') return 'source_unreachable';
  return 'source_unreachable';
}
