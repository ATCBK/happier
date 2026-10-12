import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { CHANNEL_DELIVERIES_COLLECTION } from './collections.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { waitForChannelsAccountRows } from './waitForAccountRows.js';

function collectionBoundary(onRead?: (reads: number) => void) {
  const listeners = new Set<() => void>();
  let populated = false;
  let reads = 0;
  return {
    listeners,
    get reads() { return reads; },
    populate() { populated = true; for (const listener of listeners) listener(); },
    reset() { for (const listener of listeners) listener(); },
    async query(request: Readonly<{ prefix?: readonly unknown[] }>) {
      reads += 1;
      const page = { rows: populated && request.prefix === undefined
        ? [{ rowId: 'identity', revision: 1, value: { id: 'identity', 'record-kind': 'connection-identity-key' } }]
        : [], changeCursor: reads };
      onRead?.(reads);
      return page;
    },
    watch(_request: unknown, listener: () => void) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    },
  };
}

function backgroundContext(state: ReturnType<typeof collectionBoundary>, deliveries: ReturnType<typeof collectionBoundary>, signal: AbortSignal) {
  // Account Collection transport and invalidation are genuine host boundaries.
  const services = {
    storage: { account: { collection: (definition: Readonly<{ id: string }>) => (
      definition.id === CHANNEL_DELIVERIES_COLLECTION.id ? deliveries : state
    ) } },
    logger: { warn: vi.fn() },
  } as unknown as PluginServices;
  return {
    surface: 'background',
    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    contribution: { id: 'idle-test', qualifiedId: `${PLUGIN_MANIFEST.id}/backgroundServices/idle-test` },
    invokedAtMs: 0,
    signal,
    services,
  } satisfies BackgroundServiceContext;
}

describe('registered Channels background service idle demand', () => {
  it.each(['ingress-supervisor', 'outward-delivery-supervisor'])(
    '%s parks an empty Account, recovers on reset/mutation and retires its watches', async (id) => {
      vi.useFakeTimers();
      const state = collectionBoundary();
      const deliveries = collectionBoundary();
      const generation = new AbortController();
      const context = backgroundContext(state, deliveries, generation.signal);
      const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: context.services });
      const runner = activation.registration('backgroundServices', id);
      if (!runner) throw new Error('Expected registered background service');
      const run = runner(context);
      try {
        await vi.advanceTimersByTimeAsync(0);
        const initialReads = state.reads + deliveries.reads;
        expect(initialReads).toBeGreaterThan(0);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.reads + deliveries.reads).toBe(initialReads);
        expect(state.listeners.size).toBe(1);
        expect(deliveries.listeners.size).toBe(1);

        state.reset();
        await vi.advanceTimersByTimeAsync(0);
        const resetReads = state.reads + deliveries.reads;
        expect(resetReads).toBeGreaterThan(initialReads);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(state.reads + deliveries.reads).toBe(resetReads);

        state.populate();
        await vi.advanceTimersByTimeAsync(0);
        expect(state.reads + deliveries.reads).toBeGreaterThan(resetReads);
        expect(state.listeners.size + deliveries.listeners.size).toBe(0);
      } finally {
        generation.abort();
        await run;
        await activation.dispose();
        vi.useRealTimers();
      }
      expect(state.listeners.size + deliveries.listeners.size).toBe(0);
    },
  );

  it('does not lose a mutation that arrives during the empty reread', async () => {
    const generation = new AbortController();
    const state = collectionBoundary(reads => { if (reads === 2) state.populate(); });
    const deliveries = collectionBoundary();
    await waitForChannelsAccountRows(backgroundContext(state, deliveries, generation.signal));
    expect(state.reads).toBe(3);
    expect(state.listeners.size + deliveries.listeners.size).toBe(0);
  });

  it('retires an empty parked observation on generation cancellation', async () => {
    const generation = new AbortController();
    const state = collectionBoundary();
    const deliveries = collectionBoundary();
    const run = waitForChannelsAccountRows(backgroundContext(state, deliveries, generation.signal));
    await vi.waitFor(() => expect(state.reads).toBe(2));
    generation.abort();
    await run;
    expect(state.listeners.size + deliveries.listeners.size).toBe(0);
  });

  it('leaves an unavailable initial census with the existing active retry owner', async () => {
    const generation = new AbortController();
    const state = collectionBoundary(() => { throw new Error('private transport detail'); });
    const deliveries = collectionBoundary();
    const context = backgroundContext(state, deliveries, generation.signal);
    await waitForChannelsAccountRows(context);
    expect(state.listeners.size + deliveries.listeners.size).toBe(0);
    expect(context.services.logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(context.services.logger.warn).mock.calls)).not.toContain('private');
  });
});
