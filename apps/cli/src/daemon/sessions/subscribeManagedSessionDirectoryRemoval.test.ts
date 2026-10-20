import { access, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { subscribeManagedSessionDirectoryRemoval } from './subscribeManagedSessionDirectoryRemoval';

// Configuration and logger are environment/filesystem boundaries. Allocation,
// protection, persisted ownership and removal run against real temp directories.
vi.mock('@/configuration', () => ({ configuration: { activeServerDir: '/unused' } }));
vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createSource<T>() {
  const listeners = new Set<(change: T) => void | Promise<void>>();
  return {
    subscribe(listener: (change: T) => void | Promise<void>) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async emit(change: T) {
      for (const listener of listeners) await listener(change);
    },
  };
}

async function createHarness() {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-managed-removal-'));
  roots.push(activeServerDir);
  const directories = createManagedSessionDirectories({ activeServerDir });
  const connection = createSource<{ phase: 'online' | 'offline' }>();
  return {
    directories,
    connection,
    onConnectionStateChange: connection.subscribe,
    fetchInventoryPage: async () => ({
      sessions: (await directories.listRecords()).flatMap((record) => record.sessionId ? [{ id: record.sessionId }] : []),
      hasNext: false,
      nextCursor: null,
    }),
    deleted: createSource<{ sessionId: string }>(),
    reset: createSource<{ cursor: number }>(),
  };
}

describe('subscribeManagedSessionDirectoryRemoval', () => {
  it('stops the tracked session before deleting all its allocations, and accepts redelivery', async () => {
    const harness = await createHarness();
    const first = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:first' });
    const second = await harness.directories.allocateForHandoff({ operationId: 'handoff-back', sessionId: 'session' });
    await harness.directories.bind({ allocationId: first.allocationId, sessionId: 'session' });
    await writeFile(join(first.directory, 'notes.md'), 'retained work');
    let stopped = false;
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async () => {
        if (stopped) return { status: 'not_found' };
        expect(await readFile(join(first.directory, 'notes.md'), 'utf8')).toBe('retained work');
        stopped = true;
        return { status: 'stopped' };
      },
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
    });

    await harness.deleted.emit({ sessionId: 'session' });
    expect(stopped).toBe(true);
    await expect(access(first.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(second.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(harness.deleted.emit({ sessionId: 'session' })).resolves.toBeUndefined();
    expect(await harness.directories.listRecords()).toEqual([]);
    dispose();
  });

  it('reconciles only after complete active and archived inventory and keeps archived folders', async () => {
    const harness = await createHarness();
    for (const sessionId of ['active', 'archived', 'gone']) {
      const allocation = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: `creation:${sessionId}` });
      await harness.directories.bind({ allocationId: allocation.allocationId, sessionId });
    }
    let inventory: 'complete' | 'partial' | 'failed' = 'partial';
    const stopped: string[] = [];
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async (sessionId) => { stopped.push(sessionId); return { status: 'stopped' }; },
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
      fetchInventoryPage: async ({ scope, cursor }) => {
        if (inventory === 'failed' && scope === 'archived') throw new Error('network_unavailable');
        if (scope === 'active') return { sessions: [{ id: 'active' }], hasNext: false, nextCursor: null };
        if (!cursor) return { sessions: [], hasNext: true, nextCursor: inventory === 'partial' ? null : 'archived-2' };
        return { sessions: [{ id: 'archived' }], hasNext: false, nextCursor: null };
      },
    });

    await expect(harness.reset.emit({ cursor: 1 })).resolves.toBeUndefined();
    expect((await harness.directories.listRecords()).map((record) => record.sessionId).sort()).toEqual(['active', 'archived', 'gone']);
    inventory = 'failed';
    await expect(harness.reset.emit({ cursor: 2 })).resolves.toBeUndefined();
    expect(stopped).toEqual([]);
    inventory = 'complete';
    await harness.reset.emit({ cursor: 3 });
    expect(stopped).toEqual(['gone']);
    expect((await harness.directories.listRecords()).map((record) => record.sessionId).sort()).toEqual(['active', 'archived']);
    dispose();
    await harness.deleted.emit({ sessionId: 'active' });
    expect((await harness.directories.listRecords()).map((record) => record.sessionId).sort()).toEqual(['active', 'archived']);
  });

  it('resolves crash-before-bind records at startup and removes only creations with no row', async () => {
    const harness = await createHarness();
    const found = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:found' });
    const deleted = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:deleted' });
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async () => ({ status: 'stopped' }),
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
      lookupCreationSessions: async ({ tags }) => ({
        state: 'available',
        sessions: tags[0] === 'creation:found' ? [{ id: 'found-session' }] : [],
      }),
    });

    expect(await harness.directories.listRecords()).toEqual([
      expect.objectContaining({ allocationId: found.allocationId, sessionId: 'found-session' }),
    ]);
    await expect(access(found.directory)).resolves.toBeUndefined();
    await expect(access(deleted.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    dispose();
  });

  it('retains an unbound creation when tag lookup is unavailable', async () => {
    const harness = await createHarness();
    const allocation = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:unknown' });
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async () => ({ status: 'stopped' }),
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
      lookupCreationSessions: async () => ({ state: 'unavailable' }),
    });
    expect(await harness.directories.listRecords()).toEqual([
      expect.objectContaining({ allocationId: allocation.allocationId, sessionId: null }),
    ]);
    await expect(access(allocation.directory)).resolves.toBeUndefined();
    dispose();
  });

  it('retains a failed runner retirement for deletion-cursor redelivery before removing directories', async () => {
    const harness = await createHarness();
    const allocation = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:pending' });
    await harness.directories.bind({ allocationId: allocation.allocationId, sessionId: 'pending-session' });
    let available = false;
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async () => {
        if (!available) throw new Error('process_boundary_unavailable');
        return { status: 'stopped' };
      },
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
    });
    await expect(harness.deleted.emit({ sessionId: 'pending-session' })).rejects.toThrow('process_boundary_unavailable');
    expect(await harness.directories.listRecords()).toEqual([
      expect.objectContaining({ allocationId: allocation.allocationId, sessionId: 'pending-session' }),
    ]);
    await expect(access(allocation.directory)).resolves.toBeUndefined();
    available = true;
    await harness.deleted.emit({ sessionId: 'pending-session' });
    expect(await harness.directories.listRecords()).toEqual([]);
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    dispose();
  });

  it('does not acknowledge incomplete runner retirement for a Session without managed directories', async () => {
    const harness = await createHarness();
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness, token: 'token', stopSession: async () => ({ status: 'incomplete', reason: 'runner_signal_incomplete' }),
      onSessionDeletedChange: harness.deleted.subscribe, onSessionAccessReset: harness.reset.subscribe,
    });
    await expect(harness.deleted.emit({ sessionId: 'unmanaged-session' }))
      .rejects.toThrow('deleted_session_runner_retirement_incomplete');
    dispose();
  });

  it('does not assign ownership when a creation tag resolves ambiguously', async () => {
    const harness = await createHarness();
    const allocation = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:ambiguous' });
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async () => ({ status: 'stopped' }),
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
      lookupCreationSessions: async () => ({ state: 'available', sessions: [{ id: 'one' }, { id: 'two' }] }),
    });
    expect(await harness.directories.listRecords()).toEqual([
      expect.objectContaining({ allocationId: allocation.allocationId, sessionId: null }),
    ]);
    await expect(access(allocation.directory)).resolves.toBeUndefined();
    dispose();
  });

  it('keeps deletion subscribed and continues startup cleanup after a network failure for one record', async () => {
    const harness = await createHarness();
    const failed = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'network-failed' });
    const gone = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'gone' });
    const retained = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'retained' });
    await harness.directories.bind({ allocationId: retained.allocationId, sessionId: 'retained-session' });
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness, token: 'token', stopSession: async () => ({ status: 'not_found' }),
      onSessionDeletedChange: harness.deleted.subscribe, onSessionAccessReset: harness.reset.subscribe,
      lookupCreationSessions: async ({ tags }) => {
        if (tags[0] === 'network-failed') throw new Error('network_unavailable');
        return { state: 'available', sessions: [] };
      },
    });
    await expect(access(failed.directory)).resolves.toBeUndefined();
    await expect(access(gone.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await harness.deleted.emit({ sessionId: 'retained-session' });
    await expect(access(retained.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    dispose();
  });

  it('retries an unbound pending removal instead of rebinding its creation tag', async () => {
    const harness = await createHarness();
    const allocation = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: 'creation:pending-unbound' });
    const [{ allocationId: _allocationId, directory: _directory, ...record }] = await harness.directories.listRecords();
    // Filesystem fixture for the persisted result of an interrupted prior removal.
    await writeFile(join(dirname(allocation.directory), '.owners', `${allocation.allocationId}.json`),
      JSON.stringify({ ...record, pendingRemoval: true }));
    const dispose = await subscribeManagedSessionDirectoryRemoval({
      ...harness,
      token: 'token',
      stopSession: async () => ({ status: 'stopped' }),
      onSessionDeletedChange: harness.deleted.subscribe,
      onSessionAccessReset: harness.reset.subscribe,
      lookupCreationSessions: async () => ({ state: 'available', sessions: [{ id: 'already-deleted' }] }),
    });
    expect(await harness.directories.listRecords()).toEqual([]);
    await expect(access(allocation.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    dispose();
  });

  it.each(['bootstrap', 'connect', 'reconnect'] as const)(
    'recovers missed deletion on healthy %s without removing active, archived or unknown allocations',
    async (recovery) => {
      const harness = await createHarness();
      const allocations = new Map<string, string>();
      for (const sessionId of ['active', 'archived', 'gone', 'unknown']) {
        const allocation = await harness.directories.materializeForFreshSpawn({ sessionCreationTag: `creation:${sessionId}` });
        if (sessionId !== 'unknown') await harness.directories.bind({ allocationId: allocation.allocationId, sessionId });
        await writeFile(join(allocation.directory, 'notes.md'), sessionId);
        allocations.set(sessionId, allocation.directory);
      }
      let inventoryAvailable = false;
      const stopped: string[] = [];
      const params = {
        ...harness,
        token: 'token',
        stopSession: async (sessionId: string) => { stopped.push(sessionId); return { status: 'stopped' as const }; },
        onSessionDeletedChange: harness.deleted.subscribe,
        onSessionAccessReset: harness.reset.subscribe,
        lookupCreationSessions: async () => ({ state: 'unavailable' as const }),
        fetchInventoryPage: async ({ scope }: { scope: 'active' | 'archived' }) => {
          if (!inventoryAvailable) throw new Error('network_unavailable');
          return { sessions: [{ id: scope }], hasNext: false, nextCursor: null };
        },
      };
      let dispose = await subscribeManagedSessionDirectoryRemoval(params);
      const goneDirectory = allocations.get('gone')!;
      const owners = join(dirname(goneDirectory), '.owners');
      const unavailableOwners = join(dirname(goneDirectory), '.owners-unavailable');
      // A real filesystem enumeration failure prevents writing pendingRemoval.
      await rename(owners, unavailableOwners);
      await writeFile(owners, 'temporarily unavailable');
      await expect(harness.deleted.emit({ sessionId: 'gone' })).resolves.toBeUndefined();
      await rm(owners);
      await rename(unavailableOwners, owners);
      expect((await harness.directories.listRecords()).find((record) => record.sessionId === 'gone')?.pendingRemoval).toBeUndefined();
      await expect(access(goneDirectory)).resolves.toBeUndefined();

      if (recovery === 'reconnect') {
        await harness.connection.emit({ phase: 'online' });
        await expect(access(goneDirectory)).resolves.toBeUndefined();
        await harness.connection.emit({ phase: 'offline' });
      }
      inventoryAvailable = true;
      if (recovery === 'bootstrap') {
        dispose();
        dispose = await subscribeManagedSessionDirectoryRemoval(params);
      } else {
        await harness.connection.emit({ phase: 'online' });
      }
      expect(new Set(stopped)).toEqual(new Set(['gone']));
      await expect(access(goneDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const retained of ['active', 'archived', 'unknown']) {
        expect(await readFile(join(allocations.get(retained)!, 'notes.md'), 'utf8')).toBe(retained);
      }
      expect((await harness.directories.listRecords()).map((record) => record.sessionId).sort()).toEqual(['active', 'archived', null]);
      dispose();
      await harness.connection.emit({ phase: 'online' });
      expect(new Set(stopped)).toEqual(new Set(['gone']));
    },
  );
});
