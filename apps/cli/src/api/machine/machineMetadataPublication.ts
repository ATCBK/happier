import type { MachineMetadataFieldPortV1, MachineMetadataFieldReadV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { Machine } from '../types';
import type { MachineUpdateMetadataRequest } from '@happier-dev/protocol/machines/metadataUpdate';
import type { MachineContentCodec } from './machineStoredContent';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { MachineUpdateMetadataResponseSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { parseMachinePublishedMetadataV1, StoredMachinePublishedMetadataV1Schema, projectMachinePublishedMetadataFromRowV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

export type MachineMetadataPublicationContext = Readonly<{
  getMachine: () => Machine;
  socket: Parameters<typeof emitSocketWithAck<unknown, 'machine-update-metadata', MachineUpdateMetadataRequest>>[0]['socket'];
  codec: MachineContentCodec;
  expectedDataEncryptionKey: string | null;
  isContentCurrent: () => boolean;
  retireAndRefreshContent: () => Promise<void>;
  notifyMetadataChanged: () => void;
}>;
export function readOpenedMachineMetadataSnapshot(machine: Machine, contentReady: boolean): MachineMetadataFieldReadV1 {
  if (!contentReady) return { status: 'locked' };
  if (machine.metadata === null) return { status: 'unavailable' };
  const metadata = StoredMachinePublishedMetadataV1Schema.safeParse(machine.metadata);
  if (!metadata.success || !Number.isSafeInteger(machine.metadataVersion) || machine.metadataVersion < 0) return { status: 'invalid' };
  return { status: 'ready', metadata: metadata.data, metadataVersion: machine.metadataVersion };
}
/** One incumbent codec/key-bound socket write. Retry policy belongs to its caller. */
export async function publishMachineMetadataOnce(context: MachineMetadataPublicationContext,
  input: Parameters<MachineMetadataFieldPortV1['compareAndSwap']>[0]): Promise<Awaited<ReturnType<MachineMetadataFieldPortV1['compareAndSwap']>>> {
  let machine = context.getMachine();
  const { codec } = context;
  if (!context.isContentCurrent()) return { status: 'locked' };
  if (machine.metadataVersion !== input.expectedMetadataVersion) {
    const snapshot = readOpenedMachineMetadataSnapshot(machine, true);
    return snapshot.status === 'ready' ? { ...snapshot, status: 'conflict' } : snapshot;
  }
  const updated = parseMachinePublishedMetadataV1(input.metadata);
  const answer = MachineUpdateMetadataResponseSchema.parse(await emitSocketWithAck({
    socket: context.socket, event: 'machine-update-metadata', timeoutMs: null, payload: {
      machineId: machine.id, metadata: codec.encodeStored(updated), expectedVersion: input.expectedMetadataVersion,
      expectedDataEncryptionKey: context.expectedDataEncryptionKey,
    },
  }));
  if (!context.isContentCurrent() && !('result' in answer && answer.result === 'key-mismatch')) {
    throw Object.assign(new Error('Machine content key changed during publication'), { retryable: false });
  }
  if (!('result' in answer)) throw Object.assign(new Error('Machine content publication requires a client update'), { code: answer.error, retryable: false });
  if (answer.result === 'key-mismatch') {
    await context.retireAndRefreshContent();
    throw new Error('Machine content key mismatch');
  }
  if (answer.result !== 'success' && answer.result !== 'version-mismatch') throw new Error('Unexpected machine metadata update acknowledgement');
  // A same-key refresh can replace the cache while retaining this admitted codec.
  machine = context.getMachine();
  if (answer.version > machine.metadataVersion || answer.result === 'success' && answer.version === machine.metadataVersion) {
    machine.metadata = projectMachinePublishedMetadataFromRowV1(StoredMachinePublishedMetadataV1Schema.parse(codec.decodeStored(answer.metadata)), machine.metadata?.devcontainerChild);
    machine.metadataVersion = answer.version;
    if (machine.keyBasis) machine.keyBasis = { ...machine.keyBasis, metadataVersion: answer.version };
    context.notifyMetadataChanged();
  }
  const snapshot = readOpenedMachineMetadataSnapshot(machine, true);
  return snapshot.status === 'ready' ? { ...snapshot, status: answer.result === 'success' ? 'applied' : 'conflict' } : snapshot;
}
