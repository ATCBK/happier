import { basename, join, relative, resolve, sep } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { canonicalizePath, resolveConfiguredNativeHomePath, resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { discoverAgentAccountingJsonlSource } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

export class CodeBuddySourceError extends Error {
  constructor(readonly code: 'source_invalid' | 'source_unavailable' | 'source_discontinuity' | 'invalid_request', message: string) { super(message); }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isWithin(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}
export async function resolveCodeBuddySource(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv) {
  if (source.kind !== 'codebuddyHome' || (source.homeDir != null && (typeof source.homeDir !== 'string' || !source.homeDir))
    || (source.sessionFile != null && (typeof source.sessionFile !== 'string' || !source.sessionFile))) throw new CodeBuddySourceError('source_invalid', 'Invalid CodeBuddy source.');
  const configuredHome = typeof source.homeDir === 'string'
    ? resolveConfiguredPath(source.homeDir, { homeDir: resolveHomeDirFromEnvironment(env) })
    : resolveConfiguredNativeHomePath({ environmentKey: 'CODEBUDDY_CONFIG_DIR', defaultRelativePath: '.codebuddy' }, env);
  const homeDir = await canonicalizePath(configuredHome);
  const root = await canonicalizePath(join(homeDir, 'projects'));
  const info = await stat(root).catch((error: unknown) => { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; });
  if (!info?.isDirectory()) throw new CodeBuddySourceError('source_unavailable', 'CodeBuddy native history is unavailable.');
  return { homeDir, root, source: { kind: 'codebuddyHome', homeDir, ...(source.sessionFile ? { sessionFile: source.sessionFile } : {}) } satisfies AgentExternalSessionSource };
}
export async function discoverCodeBuddyFiles(root: string, signal: AbortSignal) {
  const found = await discoverAgentAccountingJsonlSource([root], signal);
  // Native main sessions are projects/<compressed-cwd>/<id>.jsonl. Subagent,
  // tool-result and stdio trees are separate native stores, not main sessions.
  return { ...found, files: found.files.filter(file => relative(root, file).split(sep).length === 2) };
}
export async function resolveCodeBuddyFile(root: string, source: AgentExternalSessionSource, id: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!id || /[/\\\0]/.test(id) || id === '.' || id === '..') throw new CodeBuddySourceError('source_invalid', 'Invalid CodeBuddy native session identity.');
  if (typeof source.sessionFile === 'string') {
    const lexical = resolve(source.sessionFile);
    const physical = await realpath(lexical).catch(() => null);
    if (!physical || physical !== lexical || !isWithin(root, physical) || relative(root, physical).split(sep).length !== 2
      || basename(physical, '.jsonl') !== id || !physical.endsWith('.jsonl')) throw new CodeBuddySourceError('source_invalid', 'CodeBuddy session is outside its source.');
    return physical;
  }
  const files = (await discoverCodeBuddyFiles(root, signal)).files.filter(file => basename(file, '.jsonl') === id);
  if (files.length !== 1) throw new CodeBuddySourceError('source_invalid', 'CodeBuddy session is absent or ambiguous.');
  const physical = await realpath(files[0]!);
  if (!isWithin(root, physical) || physical !== files[0]) throw new CodeBuddySourceError('source_invalid', 'CodeBuddy session is outside its source.');
  return physical;
}
