import { readdir, readFile, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';
import { canonicalizePath, resolveConfiguredPath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { isRecord } from '@happier-dev/plugin-sdk';

export type CursorNativeFile = Readonly<{ id: string; path: string; metadataPath?: string }>;
export type CursorNativeSource = Readonly<{ homeDir: string; source: AgentExternalSessionSource }>;

export async function resolveCursorNativeSource(source: AgentExternalSessionSource): Promise<CursorNativeSource | null> {
  if (source.kind !== 'cursorHome') return null;
  if (source.homeDir != null && (typeof source.homeDir !== 'string' || !source.homeDir.trim())) return null;
  const homeDir = await canonicalizePath(resolveConfiguredPath(typeof source.homeDir === 'string'
    ? source.homeDir : join(resolveHomeDirFromEnvironment(process.env), '.cursor')));
  return { homeDir, source: { kind: 'cursorHome', homeDir } };
}

/** No symlink traversal: discovery stays in the admitted native home. */
async function entries(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Metadata is joined once per invocation, never cached across source reads. */
export async function discoverCursorNativeFiles(root: CursorNativeSource, signal: AbortSignal) {
  // Absence is authoritative only inside an available native store. A missing
  // mount/home must remain a failed read, not retire retained Memory rows.
  if (!(await lstat(root.homeDir)).isDirectory()) throw new Error('Cursor native store is not a directory.');
  const directories = new Set([root.homeDir, join(root.homeDir, 'projects'), join(root.homeDir, 'chats')]);
  const metadata = new Map<string, string>();
  for (const workspace of await entries(join(root.homeDir, 'chats'))) {
    signal.throwIfAborted();
    if (!workspace.isDirectory()) continue;
    const workspacePath = join(root.homeDir, 'chats', workspace.name); directories.add(workspacePath);
    for (const chat of await entries(workspacePath)) {
      if (!chat.isDirectory()) continue;
      const chatPath = join(workspacePath, chat.name); directories.add(chatPath);
      const meta = join(chatPath, 'meta.json');
      try { if ((await lstat(meta)).isFile()) metadata.set(chat.name, meta); }
      catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw error; }
    }
  }
  const files: CursorNativeFile[] = [];
  for (const project of await entries(join(root.homeDir, 'projects'))) {
    signal.throwIfAborted();
    if (!project.isDirectory()) continue;
    const projectPath = join(root.homeDir, 'projects', project.name); directories.add(projectPath);
    const transcripts = join(projectPath, 'agent-transcripts'); directories.add(transcripts);
    for (const entry of await entries(transcripts)) {
      signal.throwIfAborted();
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = basename(entry.name, '.jsonl');
        files.push({ id, path: join(transcripts, entry.name), metadataPath: metadata.get(id) });
      } else if (entry.isDirectory()) {
        const path = join(transcripts, entry.name); directories.add(path);
        for (const child of await entries(path)) {
          if (child.isFile() && child.name === `${entry.name}.jsonl`) {
            files.push({ id: entry.name, path: join(path, child.name), metadataPath: metadata.get(entry.name) });
          }
        }
      }
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, metadataFiles: [...metadata.values()], directories: [...directories] };
}

export async function readCursorMetadata(file: CursorNativeFile): Promise<Readonly<{
  supported: boolean; title?: string; cwd?: string; createdAtMs?: number; updatedAtMs?: number;
}>> {
  if (!file.metadataPath) return { supported: true };
  let data: unknown;
  try { data = JSON.parse(await readFile(file.metadataPath, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) return { supported: false }; throw error; }
  if (!isRecord(data) || data.schemaVersion !== 1
    || Object.keys(data).some(key => !['schemaVersion', 'createdAtMs', 'updatedAtMs', 'cwd', 'hasConversation', 'title'].includes(key))) return { supported: false };
  return { supported: true,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
    ...(typeof data.cwd === 'string' ? { cwd: data.cwd } : {}),
    ...(typeof data.createdAtMs === 'number' && Number.isFinite(data.createdAtMs) ? { createdAtMs: data.createdAtMs } : {}),
    ...(typeof data.updatedAtMs === 'number' && Number.isFinite(data.updatedAtMs) ? { updatedAtMs: data.updatedAtMs } : {}),
  };
}
