import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePath, isCanonicalAbsolutePathInsideRoot, resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { isRecord } from '@happier-dev/plugin-sdk';

export const KIRO_CHAT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class KiroSourceError extends Error {
  constructor(readonly code: 'source_invalid' | 'unavailable' | 'candidate_not_found', message: string) { super(message); }
}
export const digest = (text: string) => createHash('sha256').update(text).digest('base64url');

export async function resolveKiroChatSource(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv) {
  if (source.kind !== 'kiroChatStore') throw new KiroSourceError('source_invalid', 'Only the Kiro v1 native chat store is supported; ACP V3 history is not characterized.');
  if (source.kiroHome !== undefined && source.kiroHome !== null && typeof source.kiroHome !== 'string') throw new KiroSourceError('source_invalid', 'Invalid Kiro chat-store root.');
  const homeDir = resolveHomeDirFromEnvironment(env);
  const configured = typeof source.kiroHome === 'string' && source.kiroHome.trim() ? source.kiroHome : env.KIRO_HOME;
  const home = await canonicalizePath(configured ? resolveConfiguredPath(configured, { homeDir }) : join(homeDir, '.kiro'));
  const root = await canonicalizePath(join(home, 'sessions', 'cli'));
  if (!isCanonicalAbsolutePathInsideRoot(home, root)) throw new KiroSourceError('source_invalid', 'Kiro history root escapes its admitted home.');
  return { root, home, source: { kind: 'kiroChatStore', kiroHome: home } satisfies AgentExternalSessionSource };
}

export async function listKiroMetadata(root: string, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    signal.throwIfAborted();
    return entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.json') && KIRO_CHAT_UUID.test(entry.name.slice(0, -5)))
      .map(entry => entry.name.slice(0, -5)).sort();
  } catch { signal.throwIfAborted(); throw new KiroSourceError('unavailable', 'Kiro native history is unavailable.'); }
}

export async function readKiroMetadata(root: string, id: string, signal: AbortSignal) {
  if (!KIRO_CHAT_UUID.test(id)) throw new KiroSourceError('source_invalid', 'Invalid Kiro native chat identity.');
  const path = join(root, `${id}.json`);
  await confinedKiroFile(root, path, signal);
  const text = await readFile(path, { encoding: 'utf8', signal });
  let record: unknown;
  try { record = JSON.parse(text); } catch { throw new KiroSourceError('source_invalid', 'Unreadable Kiro metadata.'); }
  if (!isRecord(record) || record.session_id !== id || (record.version !== undefined && record.version !== 'v1')
    || (record.parent_session_id !== undefined && record.parent_session_id !== null && typeof record.parent_session_id !== 'string')) {
    throw new KiroSourceError('source_invalid', 'Unsupported Kiro metadata identity or version.');
  }
  return { record, path };
}

export async function confinedKiroFile(root: string, path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const physical = await realpath(path).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  signal.throwIfAborted();
  if (!physical) throw new KiroSourceError('candidate_not_found', 'Kiro native chat file is unavailable.');
  if (dirname(physical) !== root || !(await stat(physical)).isFile()) throw new KiroSourceError('source_invalid', 'Kiro native chat file escapes the admitted store.');
  return physical;
}
