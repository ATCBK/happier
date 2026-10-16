import {
  readSessionOwnerLocality,
  tryDecryptSessionMetadata,
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';

/** Resolve only agreeing Session-owned routing facts; never use the local machine. */
export function resolveSessionOwningMachineId(params: Readonly<{
  credentials: Parameters<typeof tryDecryptSessionMetadata>[0]['credentials'];
  rawSession: Parameters<typeof tryDecryptSessionMetadata>[0]['rawSession'] & Readonly<{ machineId?: unknown }>;
  accountEncryptionMode?: 'plain' | 'e2ee';
}>): { ok: true; machineId: string | null } | { ok: false } {
  if (params.rawSession.metadataLayoutVersion === 1) {
    if (!params.accountEncryptionMode) return { ok: false };
    const metadata = tryDecryptSessionOwnerMetadataView({ ...params, accountEncryptionMode: params.accountEncryptionMode });
    const machineId = readSessionOwnerLocality({ metadata, rawSession: params.rawSession })?.machineId;
    return machineId ? { ok: true, machineId } : { ok: false };
  }
  const readId = (value: unknown) => typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  const rawMachineId = readId(params.rawSession.machineId);
  const metadata = tryDecryptSessionMetadata(params);
  const metadataMachineId = readId(metadata?.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) return { ok: false };
  return { ok: true, machineId: rawMachineId ?? metadataMachineId };
}
