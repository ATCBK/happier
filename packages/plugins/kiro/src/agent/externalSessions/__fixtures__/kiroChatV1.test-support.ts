import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Sanitized adaptation of upstream commit a18b44bfc0bfccaede1d9208dc77a97816b55fe9
 * src/main/ai-vault/session-scanner-kiro-fixtures.ts and -kiro-parser.test.ts.
 * Evidence dialect: record version v1, flat KIRO_HOME/sessions/cli paired store.
 * Vendor context: https://kiro.dev/docs/cli/chat/. Producer CLI version is not
 * supplied upstream; this is neither an independent native capture nor ACP V3.
 */
export const KIRO_CHAT_V1_PROVENANCE = {
  dialect: 'kiro-cli-chat-v1',
  upstreamCommit: 'a18b44bfc0bfccaede1d9208dc77a97816b55fe9',
  producingCliVersion: null,
  acpIdentity: 'unproven',
} as const;

export async function createKiroChatV1Fixture(options: Readonly<{
  home: string;
  sessionId?: string;
  prompt?: string;
  assistant?: string;
  toolOutput?: string;
  parentSessionId?: string;
}>) {
  const sessionId = options.sessionId ?? '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d';
  const root = join(options.home, 'sessions', 'cli');
  await mkdir(root, { recursive: true });
  const metadataPath = join(root, `${sessionId}.json`);
  const transcriptPath = `${metadataPath}l`;
  const metadata = {
    session_id: sessionId,
    cwd: '/tmp/kiro-fixture',
    created_at: '2026-05-01T10:13:00.000000000Z',
    updated_at: '2026-05-01T10:13:02.000000000Z',
    title: 'Kiro fixture',
    ...(options.parentSessionId ? { parent_session_id: options.parentSessionId } : {}),
  };
  const records = [
    { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: options.prompt ?? 'A body-only harbor phrase café 😀\nquoted "text"' }], meta: { timestamp: 1777630381 } } },
    { version: 'v1', kind: 'AssistantMessage', data: { content: [
      { kind: 'thinking', data: { text: 'private reasoning needle' } },
      { kind: 'toolUse', data: { toolUseId: 't1', name: 'read', input: { path: 'metadata-only-needle' } } },
    ] } },
    { version: 'v1', kind: 'ToolResults', data: { content: [{ kind: 'toolResult', data: { toolUseId: 't1', content: [{ kind: 'text', data: options.toolOutput ?? 'visible tool output' }] } }] } },
    { version: 'v1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: options.assistant ?? 'Kiro reply' }] } },
  ];
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(transcriptPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return { sessionId, root, metadataPath, transcriptPath, metadata, records };
}
