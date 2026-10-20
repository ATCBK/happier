import { appendFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readAfterCodexExternalSessionTranscript } from './transcriptSource.js';

// One opt-in phase per Vitest process keeps peak RSS attributable to this
// synthetic owner path, without a live daemon, native home or inspector.
it.skipIf(!process.env.CODEX_TRANSCRIPT_MEMORY_PROFILE)('profiles a large incremental Codex rollout read', async () => {
  const phase = process.env.CODEX_TRANSCRIPT_MEMORY_PROFILE;
  const root = await mkdtemp(join(tmpdir(), 'codex-transcript-memory-profile-'));
  try {
    const codexHome = join(root, 'codex-home');
    const remoteSessionId = '11111111-1111-1111-1111-111111111111';
    const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`);
    const line = (text: string) => `${JSON.stringify({ type: 'response_item', timestamp: '2026-07-23T09:00:00.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })}\n`;
    const file = await open(filePath, 'w');
    let sizeBytes = 0;
    try {
      const metadata = `${JSON.stringify({ type: 'session_meta', timestamp: '2026-07-23T08:00:00.000Z',
        payload: { id: remoteSessionId, cwd: '/repo' } })}\n`;
      await file.writeFile(metadata);
      sizeBytes += Buffer.byteLength(metadata);
      let index = 0;
      while (sizeBytes < 128 * 1024 * 1024) {
        const batch = Array.from({ length: 512 }, () => line(`${index++}-${'x'.repeat(1024)}`)).join('');
        await file.writeFile(batch);
        sizeBytes += Buffer.byteLength(batch);
      }
    } finally {
      await file.close();
    }
    const params = { source: { kind: 'codexHome', home: 'user' } as const,
      env: { CODEX_HOME: codexHome }, activeServerDir: join(root, 'active-server'), remoteSessionId,
      maxBytes: 256 * 1024, maxItems: 100 };
    const tail = await readAfterCodexExternalSessionTranscript({ ...params, cursor: 'tail' });
    if (!tail.nextCursor) throw new Error('Expected a tail watermark');
    let cursor = tail.nextCursor;
    if (phase === 'steady-append') {
      await appendFile(filePath, line('bootstrap appended message'));
      const bootstrap = await readAfterCodexExternalSessionTranscript({ ...params, cursor });
      if (!bootstrap.nextCursor) throw new Error('Expected bootstrap continuation');
      cursor = bootstrap.nextCursor;
    }
    if (phase === 'append' || phase === 'steady-append') await appendFile(filePath, line('appended visible message'));
    const baselineMemory = process.memoryUsage();
    const start = performance.now();
    const result = await readAfterCodexExternalSessionTranscript({ ...params, cursor });
    const elapsedMs = performance.now() - start;
    expect(result.items).toHaveLength(phase === 'append' || phase === 'steady-append' ? 1 : 0);
    console.info(JSON.stringify({ benchmark: 'codex-transcript-read-after', phase, sizeBytes, elapsedMs,
      baselineMemory, finalMemory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS }));
  } finally {
    await rm(root, { recursive: true, force: true });
    console.info(JSON.stringify({ benchmark: 'codex-transcript-read-after', phase, teardownMemory: process.memoryUsage() }));
  }
}, 120_000);
