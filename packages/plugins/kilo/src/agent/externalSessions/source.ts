import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { AgentExternalSessionSource, AgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';

export class KiloStoreError extends Error {
  constructor(readonly code: AgentExternalSessionsFailureCode) { super(`Kilo native store: ${code}`); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value);
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
export function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decode(value: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); return record(parsed) ? parsed : null; }
  catch { return null; }
}

export type KiloStore = Readonly<{ root: string; source: AgentExternalSessionSource }>;
export async function resolveKiloStore(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv): Promise<KiloStore> {
  if (source.kind !== 'kiloStorage') throw new KiloStoreError('source_invalid');
  const configured = source.storageRoot ?? join(env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share'), 'kilo', 'storage');
  if (typeof configured !== 'string' || !isAbsolute(configured)) throw new KiloStoreError('source_invalid');
  const root = await realpath(configured).catch(() => { throw new KiloStoreError('unavailable'); });
  if (!(await stat(root)).isDirectory()) throw new KiloStoreError('unsupported');
  return { root, source: { kind: 'kiloStorage', storageRoot: root } };
}

// Every child read is physically confined, including ancestors of part files.
// No vendor module is imported: its Storage initialization migrates the store.
export async function confinedPath(store: KiloStore, path: string): Promise<string> {
  const physical = await realpath(path);
  const suffix = relative(store.root, physical);
  if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new KiloStoreError('source_invalid');
  return physical;
}
export async function readDocument(store: KiloStore, path: string, signal?: AbortSignal): Promise<unknown> {
  const physical = await confinedPath(store, path);
  const bytes = await readFile(physical, { encoding: 'utf8', signal });
  try { return JSON.parse(bytes) as unknown; } catch { return null; }
}
export async function children(store: KiloStore, path: string): Promise<string[]> {
  return (await readdir(await confinedPath(store, path))).sort();
}

export type KiloSession = Readonly<{
  id: string; path: string; title?: string; cwd?: string; parentID?: string;
  createdAtMs: number; updatedAtMs: number; archived: boolean;
  version: string; revert?: Readonly<{ messageID: string; partID?: string }>;
}>;
const sessionFields = new Set(['id', 'slug', 'projectID', 'directory', 'parentID', 'summary', 'share', 'title', 'version', 'time', 'permission', 'revert']);
export async function readSession(store: KiloStore, path: string, signal?: AbortSignal): Promise<KiloSession> {
  const value = await readDocument(store, path, signal);
  if (!record(value) || !isId(value.id) || typeof value.version !== 'string' || !record(value.time)
    || Object.keys(value).some(key => !sessionFields.has(key))
    || typeof value.time.created !== 'number' || !Number.isFinite(value.time.created)
    || typeof value.time.updated !== 'number' || !Number.isFinite(value.time.updated)) throw new KiloStoreError('unsupported');
  if (basename(path) !== `${value.id}.json`) throw new KiloStoreError('source_invalid');
  if (value.revert !== undefined && (!record(value.revert) || !isId(value.revert.messageID)
    || (value.revert.partID !== undefined && !isId(value.revert.partID)))) throw new KiloStoreError('unsupported');
  const revert = record(value.revert) && isId(value.revert.messageID)
    ? { messageID: value.revert.messageID, ...(isId(value.revert.partID) ? { partID: value.revert.partID } : {}) } : undefined;
  return { id: value.id, path, version: value.version, createdAtMs: value.time.created, updatedAtMs: value.time.updated,
    archived: typeof value.time.archived === 'number', ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.directory === 'string' ? { cwd: value.directory } : {}),
    ...(isId(value.parentID) ? { parentID: value.parentID } : {}), ...(revert ? { revert } : {}) };
}
export async function sessionPaths(store: KiloStore, signal: AbortSignal): Promise<string[]> {
  const root = join(store.root, 'session');
  let projects: string[];
  try { projects = await children(store, root); }
  catch (error) { if (record(error) && error.code === 'ENOENT') throw new KiloStoreError('unsupported'); throw error; }
  const paths: string[] = [];
  for (const project of projects) {
    signal.throwIfAborted();
    if (!isId(project)) continue;
    for (const file of await children(store, join(root, project))) {
      if (file.endsWith('.json') && isId(file.slice(0, -5))) paths.push(join(root, project, file));
    }
  }
  return paths.sort();
}
export async function findSession(store: KiloStore, id: string, signal: AbortSignal): Promise<KiloSession> {
  if (!isId(id)) throw new KiloStoreError('invalid_request');
  for (const path of await sessionPaths(store, signal)) {
    if (!path.endsWith(`${sep}${id}.json`)) continue;
    const session = await readSession(store, path, signal);
    if (session.id !== id) throw new KiloStoreError('source_invalid');
    return session;
  }
  throw new KiloStoreError('candidate_not_found');
}

export async function observationFiles(store: KiloStore, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(await confinedPath(store, path), { withFileTypes: true })) {
      signal.throwIfAborted();
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(child);
      else if (entry.isSymbolicLink()) throw new KiloStoreError('source_invalid');
    }
  }
  for (const family of ['session', 'message', 'part']) {
    try { await walk(join(store.root, family)); }
    catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; }
  }
  return files.sort();
}
