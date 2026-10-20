import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isCanonicalAbsolutePathInsideRoot, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionSource, AgentExternalSessionsFailureCode } from '@happier-dev/plugin-sdk/sessions/external';

export class AuggieSourceError extends Error {
  constructor(readonly code: AgentExternalSessionsFailureCode) { super(`Auggie native history: ${code}`); }
}
export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('base64url'); }
export function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
export function decode(value: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); return record(parsed) ? parsed : null; } catch { return null; }
}
export function isSessionId(id: string): boolean { return /^[A-Za-z0-9_-]+$/u.test(id) && !/-backup\d+$/u.test(id); }
export type AuggieStore = Readonly<{ root: string; sessions: string; source: AgentExternalSessionSource }>;
export async function resolveAuggieStore(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv): Promise<AuggieStore> {
  if (source.kind !== 'auggieHome' || Object.keys(source).some(key => !['kind', 'augmentHome'].includes(key))) throw new AuggieSourceError('source_invalid');
  const home = source.augmentHome ?? join(resolveHomeDirFromEnvironment(env), '.augment');
  if (typeof home !== 'string' || !isAbsolute(home)) throw new AuggieSourceError('source_invalid');
  const root = await realpath(home);
  const sessions = await realpath(join(root, 'sessions'));
  if (!isCanonicalAbsolutePathInsideRoot(root, sessions) || !(await stat(sessions)).isDirectory()) throw new AuggieSourceError('source_invalid');
  return { root, sessions, source: { kind: 'auggieHome', augmentHome: root } };
}
export async function sessionIds(store: AuggieStore, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted(); const entries = await readdir(store.sessions); signal.throwIfAborted();
  return entries.filter(name => name.endsWith('.json') && isSessionId(name.slice(0, -5))).map(name => name.slice(0, -5)).sort();
}
export async function sessionPath(store: AuggieStore, id: string): Promise<string> {
  if (!isSessionId(id)) throw new AuggieSourceError('invalid_request');
  const path = join(store.sessions, `${id}.json`);
  const info = await lstat(path); const physical = await realpath(path);
  if (!info.isFile() || info.isSymbolicLink() || !isCanonicalAbsolutePathInsideRoot(store.sessions, physical)) throw new AuggieSourceError('source_invalid');
  return physical;
}
export type AuggieSession = Readonly<{ id: string; createdAtMs: number; updatedAtMs: number; history: unknown[]; title?: string; parentId?: string }>;
export async function readSession(store: AuggieStore, id: string, signal: AbortSignal): Promise<AuggieSession> {
  signal.throwIfAborted();
  const bytes = await readFile(await sessionPath(store, id), { signal }); signal.throwIfAborted();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new AuggieSourceError('unsupported'); }
  // 0.36.0 stores no format-version field. Admit its writer envelope explicitly;
  // a future versioned envelope must be characterized before it is decoded.
  const envelopeFields = new Set(['sessionId', 'created', 'modified', 'chatHistory', 'agentState', 'rootTaskUuid', 'workspaceId',
    'remoteCreatedAt', 'title', 'customTitle', 'terminalId', 'subAgentCreditsUsed', 'subAgentCostUsd', 'summarizations',
    'subAgents', 'poseidonAgentId', 'parentConversationId', 'isCloudAgent', 'queue']);
  if (!record(value) || Object.keys(value).some(key => !envelopeFields.has(key))
    || value.sessionId !== id || !Array.isArray(value.chatHistory) || !record(value.agentState)
    || typeof value.agentState.userGuidelines !== 'string' || typeof value.agentState.workspaceGuidelines !== 'string'
    || typeof value.created !== 'string' || !Number.isFinite(Date.parse(value.created))
    || typeof value.modified !== 'string' || !Number.isFinite(Date.parse(value.modified))
    || ['version', 'schemaVersion', 'schema_version'].some(key => value[key] !== undefined)
    || (value.parentConversationId !== undefined && typeof value.parentConversationId !== 'string')) throw new AuggieSourceError('unsupported');
  return { id, createdAtMs: Date.parse(value.created), updatedAtMs: Date.parse(value.modified), history: value.chatHistory,
    ...(typeof value.customTitle === 'string' ? { title: value.customTitle } : typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.parentConversationId === 'string' ? { parentId: value.parentConversationId } : {}) };
}
