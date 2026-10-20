import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsProbe = vi.hoisted(() => ({
  statCalls: 0,
  abortAtStatCall: null as number | null,
  abortController: null as AbortController | null,
  advanceDeadlineAtStatCall: null as number | null,
  advanceDeadline: null as (() => void) | null,
  readBytes: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        fsProbe.readBytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
      return handle;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      fsProbe.statCalls += 1;
      if (fsProbe.statCalls === fsProbe.abortAtStatCall) {
        fsProbe.abortController?.abort(new Error('mid-transcript-scan'));
      }
      if (fsProbe.statCalls === fsProbe.advanceDeadlineAtStatCall) {
        fsProbe.advanceDeadline?.();
      }
      return await actual.stat(...args);
    },
  };
});

import {
  pageCodexExternalSessionTranscript,
  readAfterCodexExternalSessionTranscript,
} from './transcriptSource.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function createFixture(): Promise<Readonly<{
  root: string;
  params: Readonly<{
    source: { kind: 'codexHome'; home: 'user' };
    activeServerDir: string;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
  }>;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-transcript-cancel-'));
  const codexHome = join(root, 'codex-home');
  const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
  const remoteSessionId = '11111111-1111-1111-1111-111111111111';
  await mkdir(dayDir, { recursive: true });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const second = String(index).padStart(2, '0');
    await writeFile(
      join(dayDir, `rollout-2026-07-23T08-00-${second}-${remoteSessionId}.jsonl`),
      [
        jsonl({
          type: 'session_meta',
          timestamp: `2026-07-23T08:00:${second}.000Z`,
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: `2026-07-23T08:01:${second}.000Z`,
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `bounded transcript ${index}` }],
          },
        }),
      ].join(''),
      'utf8',
    );
  }));
  return {
    root,
    params: {
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'active-server'),
      env: { CODEX_HOME: codexHome },
      remoteSessionId,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  fsProbe.statCalls = 0;
  fsProbe.abortAtStatCall = null;
  fsProbe.abortController = null;
  fsProbe.advanceDeadlineAtStatCall = null;
  fsProbe.advanceDeadline = null;
  fsProbe.readBytes = 0;
});

async function appendLargeRollout(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const filePath = join(fixture.params.env.CODEX_HOME!, 'sessions', '2026', '07', '23',
    `rollout-2026-07-23T08-00-00-${fixture.params.remoteSessionId}.jsonl`);
  const body = Array.from({ length: 4096 }, (_, index) => jsonl({
    type: 'response_item', timestamp: '2026-07-23T09:00:00.000Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${index}-${'x'.repeat(1024)}` }] },
  })).join('');
  await appendFile(filePath, body);
  return { filePath, sizeBytes: Buffer.byteLength(body) };
}

describe('Codex transcript invocation bounds', () => {
  it('checks an unchanged large rollout tail without reading its transcript bodies', async () => {
    const fixture = await createFixture();
    try {
      const { sizeBytes } = await appendLargeRollout(fixture);
      const tail = await readAfterCodexExternalSessionTranscript({
        ...fixture.params, cursor: 'tail', maxBytes: 64 * 1024, maxItems: 10,
      });
      if (!tail.nextCursor) throw new Error('Expected a transcript tail cursor');
      fsProbe.readBytes = 0;
      const current = await readAfterCodexExternalSessionTranscript({
        ...fixture.params, cursor: tail.nextCursor, maxBytes: 64 * 1024, maxItems: 10,
      });
      expect(current).toMatchObject({ items: [], truncated: false, readAfterOutcome: 'already_current' });
      // Discovery and continuity may sample the source. Reading the whole old
      // body on an unchanged watermark makes every incremental index poll grow
      // with the lifetime of the native conversation.
      expect(fsProbe.readBytes).toBeLessThan(sizeBytes);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('continues a changed large rollout from semantic cursor facts without replaying its prefix', async () => {
    const fixture = await createFixture();
    try {
      const { filePath, sizeBytes } = await appendLargeRollout(fixture);
      const tail = await readAfterCodexExternalSessionTranscript({
        ...fixture.params, cursor: 'tail', maxBytes: 64 * 1024, maxItems: 10,
      });
      if (!tail.nextCursor) throw new Error('Expected a transcript tail cursor');
      const message = (text: string) => jsonl({ type: 'response_item', timestamp: '2026-07-23T10:00:00.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
      await appendFile(filePath, message('first appended text'));
      const first = await readAfterCodexExternalSessionTranscript({
        ...fixture.params, cursor: tail.nextCursor, maxBytes: 64 * 1024, maxItems: 10,
      });
      expect(first.items).toHaveLength(1);
      if (!first.nextCursor) throw new Error('Expected semantic continuation');
      await appendFile(filePath, message('first appended text') + message('second appended text'));
      fsProbe.readBytes = 0;
      const second = await readAfterCodexExternalSessionTranscript({
        ...fixture.params, cursor: first.nextCursor, maxBytes: 64 * 1024, maxItems: 10,
      });
      expect(second.items).toHaveLength(1);
      expect(JSON.stringify(second.items[0])).toContain('second appended text');
      expect(fsProbe.readBytes).toBeLessThan(sizeBytes);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('stops page filesystem effects after a mid-operation abort', async () => {
    const fixture = await createFixture();
    try {
      const controller = new AbortController();
      fsProbe.statCalls = 0;
      fsProbe.abortAtStatCall = 2;
      fsProbe.abortController = controller;

      await expect(pageCodexExternalSessionTranscript({
        ...fixture.params,
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 10,
        signal: controller.signal,
        deadlineAtMs: Date.now() + 30_000,
      })).rejects.toThrow('mid-transcript-scan');

      const settledStatCalls = fsProbe.statCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledStatCalls).toBe(2);
      expect(fsProbe.statCalls).toBe(settledStatCalls);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('stops read-after filesystem effects after a mid-operation deadline', async () => {
    const fixture = await createFixture();
    try {
      const initial = await pageCodexExternalSessionTranscript({
        ...fixture.params,
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 10,
      });
      if (!initial.tailCursor) throw new Error('Expected a transcript tail cursor');

      let nowMs = Date.now();
      const deadlineAtMs = nowMs + 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      fsProbe.statCalls = 0;
      fsProbe.advanceDeadlineAtStatCall = 2;
      fsProbe.advanceDeadline = () => {
        nowMs = deadlineAtMs;
      };

      await expect(readAfterCodexExternalSessionTranscript({
        ...fixture.params,
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 10,
        signal: new AbortController().signal,
        deadlineAtMs,
      })).rejects.toMatchObject({ name: 'TimeoutError' });

      const settledStatCalls = fsProbe.statCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledStatCalls).toBe(2);
      expect(fsProbe.statCalls).toBe(settledStatCalls);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
