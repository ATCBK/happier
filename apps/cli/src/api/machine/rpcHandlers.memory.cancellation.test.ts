import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

describe('rpcHandlers.memory cancellation', () => {
  afterEach(() => vi.resetModules());

  it('passes the target-side RPC signal through deep query embedding work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-rpc-memory-cancel-'));
    let observedSignal: AbortSignal | undefined;
    try {
      const embedQuery = vi.fn(async (_text: string, signal?: AbortSignal) => {
        observedSignal = signal;
        return new Float32Array([1]);
      });

      const dbPath = join(dir, 'deep.sqlite');
      const { openDeepIndexDb } = await import('@/daemon/memory/deepIndex/deepIndexDb');
      const db = openDeepIndexDb({ dbPath });
      db.init();
      db.insertChunk({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 1,
        createdAtFromMs: 1,
        createdAtToMs: 1,
        text: 'cancellation target',
      });
      db.close();

      type Handler = (raw: unknown, context: Readonly<{ signal: AbortSignal }>) => Promise<unknown>;
      const handlers = new Map<string, Handler>();
      const { registerMachineMemoryRpcHandlers } = await import('./rpcHandlers.memory');
      registerMachineMemoryRpcHandlers({
        rpcHandlerManager: {
          registerHandler: (method: string, handler: Handler) => handlers.set(method, handler),
        } as never,
        memoryWorker: {
          getSettings: () => ({
            ...DEFAULT_MEMORY_SETTINGS,
            enabled: true,
            indexMode: 'deep',
            embeddings: {
              ...DEFAULT_MEMORY_SETTINGS.embeddings,
              mode: 'preset',
            },
          }),
          getDeepDbPath: () => dbPath,
          getTier1DbPath: () => null,
          embedQuery,
        } as never,
      });

      const controller = new AbortController();
      await handlers.get(RPC_METHODS.DAEMON_MEMORY_SEARCH)!({
        v: 1,
        query: 'cancellation',
        scope: { type: 'global' },
        mode: 'deep',
      }, { signal: controller.signal });

      expect(observedSignal).toBe(controller.signal);
      expect(embedQuery).toHaveBeenCalledWith('cancellation', controller.signal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
