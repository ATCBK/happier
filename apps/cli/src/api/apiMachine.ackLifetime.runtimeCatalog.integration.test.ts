import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import type { Machine } from './types';
import { ApiMachineClient } from './apiMachine';

const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' };
const machine = (): Machine => ({ id: 'machine-1', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 });

describe('ApiMachine operation-owned ACK lifetimes', () => {
  it.each(['metadata', 'state'] as const)('rejoins a committed %s CAS after transport loss without applying its mutation twice', async kind => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const current = machine();
    const client = new ApiMachineClient('token', current);
    let committed: string | null = null;
    let version = kind === 'metadata' ? current.metadataVersion : current.daemonStateVersion;
    let lost = false;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (_event, raw) => {
      const request = raw as { expectedVersion: number; metadata?: string; daemonState?: string };
      const content = request.metadata ?? request.daemonState;
      if (content === undefined) throw new Error('Missing publication content');
      const result = request.expectedVersion === version ? 'success' : 'version-mismatch';
      if (result === 'success') { committed = content; version += 1; }
      if (!lost) { lost = true; throw new Error('socket has been disconnected'); }
      return { result, version, [kind === 'metadata' ? 'metadata' : 'daemonState']: committed };
    } });
    Reflect.set(client, 'socket', socket);
    const pending = kind === 'metadata'
      ? client.updateMachineMetadata(previous => ({ ...previous!, displayName: `${previous?.displayName ?? ''}!` }))
      : client.updateDaemonState(previous => ({ ...previous, status: previous?.status ?? 'running', contributionRegistryProjectionRevision: (previous?.contributionRegistryProjectionRevision ?? 0) + 1 }));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe('published');
    if (kind === 'metadata') expect(current.metadata?.displayName).toBe('!');
    else expect(current.daemonState?.contributionRegistryProjectionRevision).toBe(1);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(socket.emitWithAck.mock.calls[1]?.[1]).toEqual(socket.emitWithAck.mock.calls[0]?.[1]);
  });

  it.each([
    { event: 'machine-update-state', run: (client: ApiMachineClient) => client.updateDaemonState(() => ({ status: 'running' })),
      answer: { result: 'success', version: 1, daemonState: encodePlainMachineStoredContent({ status: 'running' }) }, result: 'published' },
  ])('awaits $event through delayed server settlement without replay', async ({ event, run, answer, result }) => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const client = new ApiMachineClient('token', machine());
    let acknowledge!: (answer: unknown) => void;
    const socket = createApiSessionSocketStub({ connected: true,
      emitWithAck: () => new Promise(resolve => { acknowledge = resolve; }),
    });
    Reflect.set(client, 'socket', socket);
    let outcome = 'pending';
    const pending = run(client);
    void pending.then(() => { outcome = 'settled'; }, () => { outcome = 'failed'; });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(outcome).toBe('pending');
    acknowledge(answer);
    await expect(pending).resolves.toEqual(result);
    const emitted = socket.emitWithAck.mock.calls.filter(([name]) => name === event);
    expect(emitted).toHaveLength(1);
  });
});
