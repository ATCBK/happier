import { storage } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { normalizeNonEmptyString, resolveVoiceMachineLabel } from './shared';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineUtils';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';

export async function listMachinesForVoiceTool(params: Readonly<{ serverId?: string; limit?: number; refresh?: boolean; purpose?: 'input' }>): Promise<unknown> {
  let state = storage.getState();
  if (params.purpose !== 'input' && !readVoicePrivacySettings(state?.settings).shareDeviceInventory) {
    return { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' };
  }
  const activeServerId = getActiveServerSnapshot().serverId;
  const serverId = params.serverId ?? activeServerId;
  if (params.refresh === true) {
    const { sync } = await import('@/sync/sync');
    await sync.refreshMachines({ serverId });
    state = storage.getState();
  }
  const machines = resolveServerScopedMachines({
    serverId, activeServerId, activeMachines: Object.values(state.machines),
    machineListByServerId: state.machineListByServerId,
    machineListStatusByServerId: state.machineListStatusByServerId,
  }) ?? [];
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;
  const names = params.purpose === 'input' ? resolveMachineDisplayNames(machines) : null;
  const scopeResolution = params.purpose === 'input' ? await resolveServerCredentialAccountScope(serverId) : null;
  const scope = scopeResolution?.kind === 'bound' ? scopeResolution.scope : null;

  // Host inputs read the already-loaded Home inventory, not the voice disclosure projection or launch readiness.
  const items = (params.purpose === 'input' ? machines : machines.slice(0, limit))
    .map((m) => ({
      serverId,
      machineId: normalizeNonEmptyString(m?.id),
      label: names?.get(m.id) ?? resolveVoiceMachineLabel(m),
      ...(params.purpose === 'input' ? { presence: isMachineReachable(scope, m) ? 'online' : 'offline',
        revokedAt: m.revokedAt, replacedByMachineId: m.replacedByMachineId } : {}),
      ...(normalizeNonEmptyString(m?.metadata?.host) ? { host: normalizeNonEmptyString(m?.metadata?.host) } : {}),
      ...(m.access ? { access: m.access } : {}),
    }))
    .filter((m) => m.machineId);

  return { items };
}
