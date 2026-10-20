import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from './machine/machineMetadataPublication';
import { createMachineContentCodec } from './machine/machineStoredContent';
import type { Machine } from './types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' };
describe('ApiMachine resources policy CAS', () => {
  it('keeps a metadata CAS pending beyond the generic ACK deadline and applies its committed revision', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const machine: Machine = { id: 'machine', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const changed = { ...metadata, displayName: 'Accepted' };
    let acknowledge!: (answer: unknown) => void;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: () => new Promise(resolve => { acknowledge = resolve; }) });
    let outcome = 'pending';
    const pending = publishMachineMetadataOnce({ getMachine: () => machine, socket, codec: createMachineContentCodec(machine),
      expectedDataEncryptionKey: null, isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} },
      { metadata: changed, expectedMetadataVersion: 1 });
    void pending.then(() => { outcome = 'applied'; }, () => { outcome = 'failed'; });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(outcome).toBe('pending');
    expect(machine.metadataVersion).toBe(1);
    acknowledge({ result: 'success', version: 2, metadata: encodePlainMachineStoredContent(changed) });
    await expect(pending).resolves.toMatchObject({ status: 'applied', metadata: changed, metadataVersion: 2 });
    expect(socket.emitWithAck).toHaveBeenCalledOnce();
  });

  it('returns a concurrent metadata revision without retrying the write', async () => {
    const machine: Machine = { id: 'machine', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const changed = { ...metadata, displayName: 'Concurrent' };
    const socket = createApiSessionSocketStub({ emitWithAckResult: { result: 'version-mismatch', version: 2, metadata: encodePlainMachineStoredContent(changed) } });
    socket.connected = true;
    const context = { getMachine: () => machine, socket, codec: createMachineContentCodec(machine), expectedDataEncryptionKey: null,
      isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} };
      expect(await publishMachineMetadataOnce(context, { metadata: { ...metadata, displayName: 'Mine' }, expectedMetadataVersion: 1 }))
        .toEqual({ status: 'conflict', metadata: changed, metadataVersion: 2 });
      expect(readOpenedMachineMetadataSnapshot(machine, true)).toEqual({ status: 'ready', metadata: changed, metadataVersion: 2 });
      expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
      expect(await publishMachineMetadataOnce(context, { metadata, expectedMetadataVersion: 1 })).toMatchObject({ status: 'conflict', metadataVersion: 2 });
      expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
  });

  it('updates the current same-key cache after a pending ACK, not the replaced snapshot', async () => {
    let current: Machine = { id: 'machine', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const admitted = current;
    const changed = { ...metadata, displayName: 'Accepted' };
    const socket = createApiSessionSocketStub();
    socket.connected = true;
    socket.emitWithAck.mockImplementation(async () => {
      current = { ...current };
      return { result: 'success', version: 2, metadata: encodePlainMachineStoredContent(changed) };
    });
    expect(await publishMachineMetadataOnce({ getMachine: () => current, socket,
      codec: createMachineContentCodec(current), expectedDataEncryptionKey: null, isContentCurrent: () => true,
      retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} }, { metadata: changed, expectedMetadataVersion: 1 }))
      .toMatchObject({ status: 'applied', metadataVersion: 2 });
    expect(readOpenedMachineMetadataSnapshot(current, true)).toMatchObject({ status: 'ready', metadata: changed, metadataVersion: 2 });
    expect(admitted.metadataVersion).toBe(1);
  });

  it('uses the E2EE codec and rejects a key change during ACK without advancing the cache', async () => {
    const machine: Machine = { id: 'machine', encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey',
      metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const codec = createMachineContentCodec(machine);
    const changed = { ...metadata, displayName: 'Encrypted' };
    const socket = createApiSessionSocketStub();
    socket.connected = true;
    let contentCurrent = true;
    socket.emitWithAck.mockImplementation(async (_event, payload) => {
      expect(payload).toMatchObject({ expectedDataEncryptionKey: 'owner-envelope', expectedVersion: 1 });
      const content = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'metadata') : undefined;
      expect(typeof content).toBe('string');
      expect(codec.decodeStored(String(content))).toEqual(changed);
      contentCurrent = false;
      return { result: 'success', version: 2, metadata: codec.encodeStored(changed) };
    });
    await expect(publishMachineMetadataOnce({ getMachine: () => machine, socket, codec, expectedDataEncryptionKey: 'owner-envelope',
      isContentCurrent: () => contentCurrent, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} },
      { metadata: changed, expectedMetadataVersion: 1 })).rejects.toMatchObject({ retryable: false });
    expect(machine.metadataVersion).toBe(1);
    expect(machine.metadata).toEqual(metadata);
    expect(readOpenedMachineMetadataSnapshot(machine, false)).toEqual({ status: 'locked' });
  });
});
