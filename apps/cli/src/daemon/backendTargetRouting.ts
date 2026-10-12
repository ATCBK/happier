import { isLegacyCustomAcpId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import {
  isCatalogAgentId,
  resolveAgentCliSubcommand,
} from '@/agent/catalog/resolution';
import {
  resolveConcreteBackendTargetRefV2,
  resolveConcreteCompatBackendTargetRefs,
} from '@/session/backendTargets/resolveConcreteBackendTargetRefs';

function resolveActiveCatalogAgentId(target: BackendTargetRefV2): CatalogAgentId | null {
  return target.backendId !== 'customAcp' && isCatalogAgentId(target.backendId)
    ? target.backendId
    : null;
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeDaemonBackendTargetV2Input(target: BackendTargetRefV2 | unknown): BackendTargetRefV2 | null {
  // Transport/daemon ingress may still carry legacy backend-target carriers (V1 shapes and
  // key strings). Canonicalize those inputs to the V2 transport shape here so downstream
  // routing stays V2-only.
  const compat = resolveConcreteCompatBackendTargetRefs(target as any);
  if (compat) {
    return compat.backendTargetV2;
  }

  const parsed = resolveConcreteBackendTargetRefV2(target as BackendTargetRefV2 | undefined);
  if (parsed) {
    return parsed;
  }

  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return null;
  }

  const record = target as Record<string, unknown>;
  if (record.kind !== 'backend' || record.sourceKind !== 'configured') {
    return null;
  }

  const backendId = readStringField(record, 'backendId');
  const configuredBackendId = readStringField(record, 'configuredBackendId');
  if (!isLegacyCustomAcpId(backendId) || !configuredBackendId || isLegacyCustomAcpId(configuredBackendId)) {
    return null;
  }

  return {
    kind: 'backend',
    backendId: configuredBackendId,
    configuredBackendId,
    sourceKind: 'configured',
  };
}

export function resolveDaemonCatalogAgentIdFromBackendTarget(
  target: BackendTargetRefV2 | undefined,
): CatalogAgentId | null {
  // Admission already resolved the contribution and retained any definition.
  // Ingress normalization would reinterpret that runtime reference as an
  // authored configured-backend selection instead of its admitted catalog id.
  if (target?.kind !== 'backend' || target.sourceKind !== 'built_in') {
    return null;
  }
  return resolveActiveCatalogAgentId(target);
}

export function resolveDaemonCliSubcommandFromBackendTarget(
  target: BackendTargetRefV2 | undefined,
): CatalogAgentId | 'acp-catalog' | null {
  if (target?.kind !== 'backend') {
    return null;
  }
  if (target.sourceKind === 'configured') {
    return 'acp-catalog';
  }
  const agentId = resolveDaemonCatalogAgentIdFromBackendTarget(target);
  return agentId ? resolveAgentCliSubcommand(agentId) : null;
}
