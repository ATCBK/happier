import { composeProviderSettingsV1, splitProviderSettingsV1,
  type ProviderConnectionsCatalogV1, type ProviderConnectionsCatalogSnapshotV1 } from '../../providers/connections/connectionRowsV1.js';
import { hasProviderMachineStateV1, removeProviderMachineStateV1 } from '../../providers/settings/operationsV1.js';

export type MachineRevokeWithProviderCleanupResult =
  | Readonly<{ ok: true; machineAlreadyRevoked: boolean; providerCleanup: 'complete' | 'not_needed' }>
  | Readonly<{ ok: false; status: number; error: 'provider_cleanup_pending' | 'provider_settings_unreadable';
      machineRevoked: true; providerCleanup: 'pending'; retryable: boolean }>
  | Readonly<{ ok: false; status: number; error: string }>;

function pendingProviderCleanup(unreadable = false): Extract<MachineRevokeWithProviderCleanupResult, { machineRevoked: true }> {
  return { ok: false, status: unreadable ? 409 : 503,
    error: unreadable ? 'provider_settings_unreadable' : 'provider_cleanup_pending',
    machineRevoked: true, providerCleanup: 'pending', retryable: !unreadable };
}

/** One Account-scoped revoke/cleanup sequence; UI and CLI supply their incumbent transports. */
export async function revokeMachineWithProviderCleanup(machineId: string, ports: Readonly<{
  revoke(): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  readCatalog(): Promise<ProviderConnectionsCatalogSnapshotV1>;
  writeCatalog(value: { catalog: ProviderConnectionsCatalogV1; expectedRevision: number | 'absent' }): Promise<{ status: string }>;
}>): Promise<MachineRevokeWithProviderCleanupResult> {
  const id = String(machineId ?? '').trim();
  if (!id) return { ok: false, status: 400, error: 'machine_id_required' };
  const revoked = await ports.revoke();
  const machineAlreadyRevoked = !revoked.ok && revoked.status === 410 && revoked.error === 'machine_revoked';
  if (!revoked.ok && !machineAlreadyRevoked) return revoked;
  try {
    const captured = await ports.readCatalog();
    if (captured.status !== 'ready') {
      return pendingProviderCleanup(captured.status === 'partial'
        || captured.status === 'unavailable' && captured.reason === 'invalid-stored-content');
    }
    const settings = composeProviderSettingsV1(captured.catalog, {});
    if (!hasProviderMachineStateV1(settings, id)) {
      return { ok: true, machineAlreadyRevoked, providerCleanup: 'not_needed' };
    }
    const catalog = splitProviderSettingsV1(removeProviderMachineStateV1(settings, id)).catalog;
    const mutation = await ports.writeCatalog({ catalog, expectedRevision: captured.revision });
    return mutation.status === 'updated'
      ? { ok: true, machineAlreadyRevoked, providerCleanup: 'complete' }
      : pendingProviderCleanup();
  } catch {
    return pendingProviderCleanup();
  }
}
