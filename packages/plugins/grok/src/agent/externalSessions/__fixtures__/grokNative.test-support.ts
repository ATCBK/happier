import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Characterized, sanitized upstream dialect, not a native CLI capture.
 * upstream commit a18b44bfc0bfccaede1d9208dc77a97816b55fe9:
 * session-scanner-grok-parser.test.ts and session-scanner-grok-parser.ts.
 * Vendor sessions.md (2026-10-20) establishes automatic persistence and
 * conversation truncation on rewind. No producing Grok version is asserted.
 */
export const GROK_NATIVE_FIXTURE_PROVENANCE = {
  dialect: 'unversioned-summary-info-and-type-content-jsonl',
  evidence: 'upstream commit a18b44bfc0bfccaede1d9208dc77a97816b55fe9',
  vendor: 'https://docs.x.ai/build/features/sessions.md',
  nativeCapture: false,
} as const;

export async function createGrokNativeHistoryFixture(home: string, id = '11111111-1111-4111-8111-111111111111') {
  const root = join(home, '.grok', 'sessions');
  // Discover the group rather than synthesizing the CLI's long-cwd hash.
  const dir = join(root, 'workspace-4a0d5853086bbc19', id);
  await mkdir(dir, { recursive: true });
  const summaryPath = join(dir, 'summary.json');
  const historyPath = join(dir, 'chat_history.jsonl');
  const summary = { info: { id, cwd: '/workspace/long-cwd' }, generated_title: 'A native conversation',
    created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:01:00Z' };
  const records = [
    { type: 'user', content: [{ type: 'text', text: 'A body-only phrase with "quotes"\n東京 café' }], timestamp: '2026-10-01T10:00:01Z' },
    { type: 'assistant', content: `${'x'.repeat(5000)} distantbody <user_query>literal tags</user_query>`, timestamp: '2026-10-01T10:00:02Z' },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'shell', input: { command: 'metadata-only secret' } }], timestamp: '2026-10-01T10:00:03Z' },
  ];
  const writeRecords = (rows: readonly unknown[]) => writeFile(historyPath,
    rows.map(row => JSON.stringify(row).replaceAll('東京', '\\u6771\\u4eac')).join('\n') + '\n');
  await writeFile(summaryPath, JSON.stringify(summary));
  await writeRecords(records);
  return { root, dir, summaryPath, historyPath, summary, records, writeRecords, id };
}
