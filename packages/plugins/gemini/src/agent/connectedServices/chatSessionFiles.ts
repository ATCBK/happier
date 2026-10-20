import { copyFile, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';

import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/fs';

const GEMINI_CHAT_SESSION_FILE_HEAD_BYTES = 16_384;

export type GeminiChatSessionFileMatch = Readonly<{
  filePath: string;
  projectSlug: string;
}>;

export type GeminiChatSessionImportResult = Readonly<{
  imported: boolean;
  reason?: 'no_vendor_resume_id' | 'already_present' | 'source_session_file_not_found' | 'project_slug_unresolved';
  destinationPath?: string;
}>;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function resolveGeminiDirForEnv(env: Readonly<Record<string, string | undefined>>): string {
  const home = asNonEmptyString(env.GEMINI_CLI_HOME) ?? asNonEmptyString(env.HOME) ?? homedir();
  return join(home, '.gemini');
}

export async function readGeminiProjectsMap(geminiDir: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(geminiDir, 'projects.json'), 'utf8');
  } catch {
    return {};
  }
  try {
    const projects = readRecord(readRecord(JSON.parse(raw))?.projects);
    if (!projects) return {};
    const result: Record<string, string> = {};
    for (const [path, slug] of Object.entries(projects)) {
      const normalizedSlug = asNonEmptyString(slug);
      if (normalizedSlug) result[path] = normalizedSlug;
    }
    return result;
  } catch {
    return {};
  }
}

function isGeminiChatSessionFileName(fileName: string): boolean {
  return fileName.startsWith('session-') && /\.jsonl?$/i.test(fileName);
}

/** Shared read-only inventory for resume import and External Sessions. Only the
 * native tmp/<project>/chats layout is traversed; symlink escapes are rejected. */
export async function listGeminiChatSessionFiles(geminiDir: string, signal?: AbortSignal): Promise<readonly GeminiChatSessionFileMatch[]> {
  const tmpDir = join(await realpath(geminiDir), 'tmp');
  const projects = await readdir(tmpDir, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const files: GeminiChatSessionFileMatch[] = [];
  for (const project of projects) {
    signal?.throwIfAborted();
    if (!project.isDirectory()) continue;
    const chats = join(tmpDir, project.name, 'chats');
    const entries = await readdir(chats, { withFileTypes: true }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile() || !isGeminiChatSessionFileName(entry.name)) continue;
      const filePath = await realpath(join(chats, entry.name));
      const child = relative(tmpDir, filePath);
      if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child)) {
        throw new Error('Gemini session file is outside the native history root');
      }
      files.push({ filePath, projectSlug: project.name });
    }
  }
  return files.sort((a, b) => a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0);
}

export function geminiChatSessionFileNameMatchesSessionId(fileName: string, sessionId: string): boolean {
  const shortId = sessionId.slice(0, 8);
  return isGeminiChatSessionFileName(fileName) && fileName.endsWith(`-${shortId}.jsonl`);
}

export async function readGeminiChatSessionFileSessionId(filePath: string): Promise<string | null> {
  let head: string;
  try {
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(GEMINI_CHAT_SESSION_FILE_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const firstLine = head.split('\n', 1)[0]?.trim();
  if (!firstLine) return null;
  try {
    return asNonEmptyString(readRecord(JSON.parse(firstLine))?.sessionId);
  } catch {
    return null;
  }
}

export async function findGeminiChatSessionFile(params: Readonly<{
  geminiDir: string;
  sessionId: string;
  cwd?: string | null;
}>): Promise<GeminiChatSessionFileMatch | null> {
  const cwd = asNonEmptyString(params.cwd);
  const cwdSlug = cwd ? (await readGeminiProjectsMap(params.geminiDir))[cwd] ?? null : null;
  const files = await listGeminiChatSessionFiles(params.geminiDir).catch(() => []);
  const ordered = [...files.filter(file => file.projectSlug === cwdSlug), ...files.filter(file => file.projectSlug !== cwdSlug)];
  for (const file of ordered) {
    if (!geminiChatSessionFileNameMatchesSessionId(basename(file.filePath), params.sessionId) && file.projectSlug !== cwdSlug) continue;
    if (await readGeminiChatSessionFileSessionId(file.filePath) === params.sessionId) return file;
  }
  return null;
}

async function upsertGeminiProjectMapping(params: Readonly<{
  geminiDir: string;
  cwd: string;
  slug: string;
}>): Promise<void> {
  const projects = await readGeminiProjectsMap(params.geminiDir);
  if (projects[params.cwd] === params.slug) return;
  await writeAtomicJsonFile({
    path: join(params.geminiDir, 'projects.json'),
    value: { projects: { ...projects, [params.cwd]: params.slug } },
  });
}

export async function importGeminiChatSessionForResume(params: Readonly<{
  targetHomeDir: string;
  sourceEnv: Readonly<Record<string, string | undefined>>;
  cwd: string | null;
  vendorResumeId: string | null;
}>): Promise<GeminiChatSessionImportResult> {
  const sessionId = asNonEmptyString(params.vendorResumeId);
  if (!sessionId) return { imported: false, reason: 'no_vendor_resume_id' };
  const cwd = asNonEmptyString(params.cwd);
  const targetGeminiDir = join(params.targetHomeDir, '.gemini');

  const existing = await findGeminiChatSessionFile({ geminiDir: targetGeminiDir, sessionId, cwd });
  if (existing) {
    if (cwd) await upsertGeminiProjectMapping({ geminiDir: targetGeminiDir, cwd, slug: existing.projectSlug });
    return { imported: false, reason: 'already_present', destinationPath: existing.filePath };
  }

  let sourceFilePath: string | null = null;
  let sourceSlug: string | null = null;
  const sourceMatch = await findGeminiChatSessionFile({
    geminiDir: resolveGeminiDirForEnv(params.sourceEnv),
    sessionId,
    cwd,
  });
  if (sourceMatch) {
    sourceFilePath = sourceMatch.filePath;
    sourceSlug = sourceMatch.projectSlug;
  }
  if (!sourceFilePath) return { imported: false, reason: 'source_session_file_not_found' };

  const slug = sourceSlug ?? (cwd ? basename(cwd) : null);
  if (!slug) return { imported: false, reason: 'project_slug_unresolved' };

  const destinationDir = join(targetGeminiDir, 'tmp', slug, 'chats');
  await mkdir(destinationDir, { recursive: true });
  const destinationPath = join(destinationDir, basename(sourceFilePath));
  await copyFile(sourceFilePath, destinationPath);
  if (cwd) await upsertGeminiProjectMapping({ geminiDir: targetGeminiDir, cwd, slug });
  return { imported: true, destinationPath };
}
