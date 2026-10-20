import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findGeminiChatSessionFile, importGeminiChatSessionForResume, listGeminiChatSessionFiles } from './chatSessionFiles.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('shared Gemini native session file discovery', () => {
  it('keeps resume lookup/import on the same native project and file inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-gemini-files-')); roots.push(root);
    const configDir = join(root, 'source', '.gemini');
    const chats = join(configDir, 'tmp', 'project-slug', 'chats');
    await mkdir(chats, { recursive: true });
    const sessionId = '8b6e1959-546e-4a3b-a6c2-4c1d6109f210';
    const path = join(chats, 'session-current-8b6e1959.jsonl');
    const content = JSON.stringify({ sessionId, projectHash: 'project-slug' }) + '\n';
    await writeFile(path, content);
    await writeFile(join(configDir, 'projects.json'), JSON.stringify({ projects: { '/repo': 'project-slug' } }));
    expect(await listGeminiChatSessionFiles(configDir)).toEqual([{ filePath: path, projectSlug: 'project-slug' }]);
    expect(await findGeminiChatSessionFile({ geminiDir: configDir, sessionId, cwd: '/repo' }))
      .toEqual({ filePath: path, projectSlug: 'project-slug' });
    const result = await importGeminiChatSessionForResume({ targetHomeDir: join(root, 'target'),
      sourceEnv: { GEMINI_CLI_HOME: join(root, 'source') }, cwd: '/repo', vendorResumeId: sessionId });
    expect(result.imported).toBe(true);
    expect(await readFile(result.destinationPath!, 'utf8')).toBe(content);
    expect(await importGeminiChatSessionForResume({ targetHomeDir: join(root, 'target'),
      sourceEnv: { GEMINI_CLI_HOME: join(root, 'source') }, cwd: '/repo', vendorResumeId: sessionId }))
      .toMatchObject({ imported: false, reason: 'already_present' });
  });
  it('refuses a chats-directory symlink that escapes the selected native root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-gemini-confinement-')); roots.push(root);
    const configDir = join(root, '.gemini');
    await mkdir(join(configDir, 'tmp', 'project'), { recursive: true });
    const outside = join(root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'session-outside.jsonl'), '{"sessionId":"outside"}\n');
    await symlink(outside, join(configDir, 'tmp', 'project', 'chats'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(listGeminiChatSessionFiles(configDir)).rejects.toThrow('outside the native history root');
  });
});
