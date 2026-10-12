import { readMachineResourcesPolicyV1SnapshotFromMetadata, type MachineResourcesPolicyGetResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { MachineContentKeyUnavailableError } from './machineDataEncryptionKey';
import type { Machine } from '../types';

/** The Account reader returns opened content; a plain Account needs no encryption key. */
export async function readMachineResourcesPolicySnapshot(dependencies: Readonly<{
  machineId: string;
  readMachine: () => Promise<Machine | null>;
  isCurrent: () => boolean | Promise<boolean>;
}>): Promise<MachineResourcesPolicyGetResultV1> {
  if (!await dependencies.isCurrent()) return { status: 'unavailable' };
  let machine: Machine | null;
  try { machine = await dependencies.readMachine(); } catch (error) {
    return { status: error instanceof MachineContentKeyUnavailableError ? 'locked' : 'unavailable' };
  }
  if (!machine || machine.id !== dependencies.machineId || !await dependencies.isCurrent()) return { status: 'unavailable' };
  return readMachineResourcesPolicyV1SnapshotFromMetadata({ metadata: machine.metadata, metadataVersion: machine.metadataVersion, hasContentKey: true });
}
