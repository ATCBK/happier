import { basename, join } from 'node:path';

import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountRef, QualifiedConnectedAccountPurposeBindingV1 } from '@happier-dev/protocol';
import type { AgentConnectedAccountNativeHomeV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { AgentSpawnQualifiedPurposeBindingSnapshot } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceHomeDir, resolveConnectedServiceGroupHomeDir } from '../homes/resolveConnectedServiceHomeDir';

/** The one physical layout for an already selected native-home Account or group. */
export function resolveConnectedServiceNativeHomeTargetRoot(input: Readonly<{
  agentId: CatalogAgentId;
  activeServerDir: string;
  nativeHome: AgentConnectedAccountNativeHomeV1;
  target: QualifiedConnectedAccountPurposeBindingV1['target'];
}>): string | null {
  const directoryName = input.nativeHome.materializedDirectoryName;
  if (!directoryName) return null;
  if (directoryName !== basename(directoryName) || directoryName.includes('\\')
    || directoryName === '.' || directoryName === '..') {
    throw new Error('Connected Account native-home directory declaration is invalid');
  }
  const target = input.target;
  return join(target.kind === 'account' ? resolveConnectedServiceHomeDir({
      activeServerDir: input.activeServerDir,
      serviceId: buildQualifiedPluginContributionKey(target.account.service),
      profileId: target.account.accountId, agentId: input.agentId,
    }) : resolveConnectedServiceGroupHomeDir({
      activeServerDir: input.activeServerDir,
      serviceId: buildQualifiedPluginContributionKey(target.service),
      groupId: target.groupId, agentId: input.agentId,
    }), directoryName);
}

/** Read-only layout decision shared by launch preparation and runtime preflight. */
export function resolveConnectedServiceNativeHomeTarget(input: Readonly<{
  agentId: CatalogAgentId;
  activeServerDir: string;
  nativeHome: AgentConnectedAccountNativeHomeV1;
  snapshot: AgentSpawnQualifiedPurposeBindingSnapshot | null;
  expectedAccountsByPurposeKey?: ReadonlyMap<string, QualifiedConnectedAccountRef>;
  probePurpose?: 'probe';
}>): string | null {
  const directoryName = input.nativeHome.materializedDirectoryName;
  if (!directoryName || input.probePurpose === 'probe') return null;
  const nativeBindings = (input.snapshot?.bindings ?? []).filter(binding =>
    input.snapshot?.fileMaterializationPurposes?.some(scope =>
      qualifiedPurposeKey(scope.purpose) === qualifiedPurposeKey(binding.purpose)));
  if (nativeBindings.length === 0) return null;
  const roots = new Set(nativeBindings.map(binding => {
    const selectedAccount = binding.target.kind === 'group' && input.nativeHome.groupHome === 'selectedAccount'
      ? input.expectedAccountsByPurposeKey?.get(qualifiedPurposeKey(binding.purpose)) : undefined;
    if (binding.target.kind === 'group' && input.nativeHome.groupHome === 'selectedAccount'
      && (!selectedAccount || buildQualifiedPluginContributionKey(selectedAccount.service)
        !== buildQualifiedPluginContributionKey(binding.target.service))) {
      throw new Error('Connected Account native-home selected member is unavailable');
    }
    const target = selectedAccount ? { kind: 'account' as const, account: selectedAccount } : binding.target;
    return resolveConnectedServiceNativeHomeTargetRoot({ ...input, target });
  }));
  if (roots.size !== 1) throw new Error('Connected Account native-home identity is ambiguous');
  return [...roots][0]!;
}
