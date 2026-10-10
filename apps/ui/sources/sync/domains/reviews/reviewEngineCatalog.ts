import {
  BackendTargetKeyV2Schema,
  parseBackendTargetKeyV2,
  readBackendTargetRefV2,
  resolveBackendTargetKeyV2,
  type PersistedBackendTargetRefV2,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { BackendTargetKeySchema } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { isLegacyCustomAcpId, readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, isBundledAgentId } from '@happier-dev/agents/agent-ids';

export type ExecutionRunsBackendSnapshotEntry = Readonly<{
  available?: boolean;
  intents?: readonly string[];
  reviewScopes?: readonly string[];
  supportsVendorResume?: boolean;
  title?: string;
  label?: string;
  displayName?: string;
}>;

export type ReviewEngineOption = Readonly<{ id: string; label: string; disabled?: boolean }>;

/** Review options use Agent ids for catalog Agents and exact target keys for configured backends. */
export function resolveReviewEngineTarget(optionId: string): PersistedBackendTargetRefV2 {
  const explicitTargetKey = BackendTargetKeyV2Schema.safeParse(optionId);
  if (explicitTargetKey.success) return parseBackendTargetKeyV2(explicitTargetKey.data);
  const configuredBackendId = readLegacyConfiguredAcpBackendId(optionId);
  if (configuredBackendId) return readBackendTargetRefV2({ kind: 'configuredAcpBackend', backendId: configuredBackendId });
  const legacyTargetKey = BackendTargetKeySchema.safeParse(optionId);
  return legacyTargetKey.success ? readBackendTargetRefV2(legacyTargetKey.data) : { kind: 'backend', backendId: optionId };
}

function supportsReviewIntent(entry: ExecutionRunsBackendSnapshotEntry | null | undefined): boolean {
  const intents = Array.isArray(entry?.intents) ? entry.intents : null;
  if (!intents) return true; // best-effort (older snapshots)
  return intents.includes('review');
}

function isExecutableReviewEngineId(id: string): boolean {
  if (isLegacyCustomAcpId(id)) return false;
  const identity = isBundledAgentId(id) ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[id]
    : parseQualifiedPluginContributionKey(id) ?? (id.startsWith('agent:') ? parseQualifiedPluginContributionKey(id.slice('agent:'.length)) : null);
  return !identity || listAgentExecutionTargetsV1(identity).length > 0;
}

function reviewEngineTargetKey(id: string): string | null {
  if (!isExecutableReviewEngineId(id)) return null;
  try { return resolveBackendTargetKeyV2(resolveReviewEngineTarget(id)); }
  catch { return null; }
}

function resolveReviewEngineLabel(
  id: string,
  entry: ExecutionRunsBackendSnapshotEntry | null | undefined,
  resolveAgentLabel: (agentId: string) => string,
): string {
  const label = entry?.title ?? entry?.label ?? entry?.displayName;
  if (label) return label;

  try {
    return resolveAgentLabel(id);
  } catch {
    return id;
  }
}

function buildReviewEngineOption(
  id: string,
  entry: ExecutionRunsBackendSnapshotEntry | null | undefined,
  resolveAgentLabel: (agentId: string) => string,
): ReviewEngineOption {
  const label = resolveReviewEngineLabel(id, entry, resolveAgentLabel);
  const disabled = entry ? !(entry.available === true && supportsReviewIntent(entry)) : false;
  return { id, label, ...(disabled ? { disabled: true as const } : {}) };
}

export function buildAvailableReviewEngineOptions(params: Readonly<{
  enabledAgentIds: readonly string[];
  resolveAgentLabel: (agentId: string) => string;
  executionRunsBackends: Readonly<Record<string, ExecutionRunsBackendSnapshotEntry>> | null | undefined;
  scope?: 'paths';
}>): readonly ReviewEngineOption[] {
  const backends = params.executionRunsBackends ?? null;
  const includedTargetKeys = new Set<string>();
  const snapshotEntries = Object.entries(backends ?? {}).flatMap(([rawId, entry]) => {
    const id = String(rawId ?? '').trim();
    const targetKey = reviewEngineTargetKey(id);
    return targetKey ? [{ id, targetKey, entry }] : [];
  });

  const agentOptions: ReviewEngineOption[] = params.enabledAgentIds
    .map((id) => String(id ?? '').trim())
    .filter((id) => id.length > 0)
    .flatMap((id) => {
      const targetKey = reviewEngineTargetKey(id);
      if (!targetKey || includedTargetKeys.has(targetKey)) return [];
      const entry = (snapshotEntries.find(snapshot => snapshot.id === id)
        ?? snapshotEntries.find(snapshot => snapshot.targetKey === targetKey))?.entry;
      if (entry && !supportsReviewIntent(entry)) return [];
      if (params.scope === 'paths' && entry?.reviewScopes?.includes('paths') !== true) return [];
      includedTargetKeys.add(targetKey);
      if (!backends) return [{ id, label: params.resolveAgentLabel(id) }];
      // If the machine explicitly reports the backend, surface it even when unavailable so the
      // UI can explain why it's disabled instead of hiding it entirely.
      return [buildReviewEngineOption(id, entry, params.resolveAgentLabel)];
    });

  if (!backends) {
    return agentOptions;
  }

  const discoveredReviewOptions = snapshotEntries
    .filter(({ entry }) => supportsReviewIntent(entry))
    .filter(({ entry }) => params.scope !== 'paths' || entry.reviewScopes?.includes('paths') === true)
    .flatMap(({ id, targetKey, entry }) => {
      if (includedTargetKeys.has(targetKey)) return [];
      includedTargetKeys.add(targetKey);
      return [buildReviewEngineOption(id, entry, params.resolveAgentLabel)];
    });

  return [...agentOptions, ...discoveredReviewOptions];
}
