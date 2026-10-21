import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Sanitised dialect vector, not an installed-CLI capture. Basis:
 * upstream commit a18b44bfc0bfccaede1d9208dc77a97816b55fe9,
 * src/main/ai-vault/session-scanner-cursor-{parser.ts,chat-meta.test.ts}.
 * The latter identifies the real September 2026 metadata keys/version 1;
 * transcript records are unversioned role/message.content JSONL. Producing
 * CLI version is unknown. https://cursor.com/docs/cli/using (2026-10-20)
 * confirms native thread-id resume, not a versioned transcript schema.
 * Native capture plus `agent ls` id agreement is a release check.
 */
export const CURSOR_NATIVE_DIALECT = 'a18b44bfc0-role-content-meta-v1';
export const CURSOR_FIXTURE_ID = 'e284bb73-4e75-4bc8-a5ad-1d55276ed416';
export function cursorFixtureRow(role: 'user' | 'assistant', text: string) {
  return JSON.stringify({ role, message: { content: [{ type: 'text', text }] } }) + '\n';
}
export async function writeCursorNativeFixture(homeDir: string, options: { flat?: boolean; body?: string } = {}) {
  const transcriptPath = join(homeDir, 'projects', 'repo', 'agent-transcripts',
    ...(options.flat ? [] : [CURSOR_FIXTURE_ID]), `${CURSOR_FIXTURE_ID}.jsonl`);
  const metadataPath = join(homeDir, 'chats', 'workspace-hash', CURSOR_FIXTURE_ID, 'meta.json');
  await mkdir(dirname(transcriptPath), { recursive: true });
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify({ schemaVersion: 1, cwd: '/repo', title: 'Ordinary title',
    createdAtMs: Date.now(), updatedAtMs: Date.now(), hasConversation: true }));
  await writeFile(transcriptPath, cursorFixtureRow('user', 'quartz initial native message')
    + cursorFixtureRow('assistant', options.body ?? 'Body phrase with "quotes"\n東京 café'));
  return { transcriptPath, metadataPath, nativeSessionId: CURSOR_FIXTURE_ID };
}
