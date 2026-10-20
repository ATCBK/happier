import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { canonicalizePathSync, isCanonicalAbsolutePathInsideRoot, resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

export class QwenSourceError extends Error {
  constructor(readonly code: 'source_invalid' | 'agent_unavailable' | 'candidate_not_found' | 'unsupported' | 'invalid_request' | 'agent_error', message: string) { super(message); }
}
export type QwenSource = Readonly<{ runtimeDir: string; source: AgentExternalSessionSource }>;
export type QwenFile = Readonly<{ path: string; relativePath: string; sessionId: string; archived: boolean; updatedAtMs: number }>;
export function resolveQwenSource(source: AgentExternalSessionSource, env: NodeJS.ProcessEnv): QwenSource {
  if (source.kind !== 'qwenRuntimeDir') throw new QwenSourceError('source_invalid', 'Qwen source kind is unsupported.');
  const root = typeof source.runtimeDir === 'string' && source.runtimeDir.trim() ? source.runtimeDir
    : env.QWEN_RUNTIME_DIR?.trim() || env.QWEN_HOME?.trim() || join(resolveHomeDirFromEnvironment(env), '.qwen');
  const runtimeDir = canonicalizePathSync(resolveConfiguredPath(root, { homeDir: resolveHomeDirFromEnvironment(env) }));
  return { runtimeDir, source: { kind: 'qwenRuntimeDir', runtimeDir } };
}
export function validSessionId(id: string): boolean {
  return id.length > 0 && id !== '.' && id !== '..' && !/[\\/\u0000]/.test(id);
}
async function directory(path: string) {
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new QwenSourceError('source_invalid', 'Qwen history directory is not a native directory.');
  return opendir(path);
}
export async function validateQwenHistoryRoot(source: QwenSource): Promise<void> {
  // Source-wide observation must share candidate admission's no-symlink rule.
  // The SDK discovery helper treats its supplied root as already admitted.
  const root = await directory(join(source.runtimeDir, 'projects'));
  await root?.close();
}

/** v0.25.3 Storage.getProjectDir + SessionService.getArchiveChatsDir.
 * Do not recursively admit arbitrary JSONL stores or follow vendor symlinks. */
export async function listQwenFiles(source: QwenSource, signal: AbortSignal): Promise<readonly QwenFile[]> {
  const projects = await directory(join(source.runtimeDir, 'projects'));
  if (!projects) throw new QwenSourceError('agent_unavailable', 'Qwen history is unavailable.');
  const files: QwenFile[] = [];
  for await (const project of projects) {
    signal.throwIfAborted();
    if (project.isSymbolicLink()) throw new QwenSourceError('source_invalid', 'Qwen history project is a symlink.');
    if (!project.isDirectory()) continue;
    const chats = join(source.runtimeDir, 'projects', project.name, 'chats');
    for (const archived of [false, true]) {
      const root = archived ? join(chats, 'archive') : chats;
      const entries = await directory(root); if (!entries) continue;
      for await (const entry of entries) {
        signal.throwIfAborted();
        if (!entry.name.endsWith('.jsonl')) continue;
        if (entry.isSymbolicLink()) throw new QwenSourceError('source_invalid', 'Qwen transcript is a symlink.');
        if (!entry.isFile()) continue;
        const path = await realpath(join(root, entry.name));
        if (!isCanonicalAbsolutePathInsideRoot(source.runtimeDir, path)) throw new QwenSourceError('source_invalid', 'Qwen transcript leaves its source root.');
        const info = await lstat(path);
        files.push({ path, relativePath: relative(source.runtimeDir, path), sessionId: entry.name.slice(0, -6), archived, updatedAtMs: Math.trunc(info.mtimeMs) });
      }
    }
  }
  return files.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.relativePath.localeCompare(b.relativePath));
}
