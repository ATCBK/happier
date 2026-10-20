import { homedir } from 'node:os';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { assertResolvedHomeTargetIdentity, HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { normalizeServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentFoundSkillSources } from '@/agent/skills/resolveAgentSkillsCapability';
import { detectCliSnapshotOnDaemonPath } from '@/capabilities/snapshots/cliSnapshot';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createMachineSkillActions } from './machineSkillActions';

/** Captured daemon Home authority; a saved identity is already canonical, otherwise observe that exact Home. */
export async function resolveMachineSkillInstallTarget(input: Readonly<{
  serverId: string; serverHttpBaseUrl: string; machineId: string; signal?: AbortSignal;
}>): Promise<MachineAdministrationTargetV1 | null> {
  input.signal?.throwIfAborted();
  const home = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: input.serverId }).catch(error => {
    if (!(error instanceof HomeTargetResolutionError) || error.code !== 'profile_missing') throw error;
    return resolveCliHomeTarget({ kind: 'https_url', url: input.serverHttpBaseUrl });
  });
  input.signal?.throwIfAborted();
  if (home.homeServerIdentityId
    && normalizeServerHttpBaseUrl(home.applicationUrl) === normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)) {
    return { machineId: input.machineId, serverIdentityId: home.homeServerIdentityId };
  }
  // A verified carrier may be process-local while the descriptor retains its
  // canonical HTTPS audience. Identity, not carrier URL equality, binds that Home.
  const observed = await createCurrentMachineExecutionOriginContextResolver({ serverUrl: input.serverHttpBaseUrl,
    resolveCurrentMachineId: () => input.machineId })(input.signal);
  return observed ? { ...observed, serverIdentityId: assertResolvedHomeTargetIdentity(home, observed.serverIdentityId) } : null;
}

/** Both admitted Actions and Account-change refresh consume this same native/C5 composition. */
export function createMachineSkillHostService(input: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  target: MachineAdministrationTargetV1; operationContext?: SavedSecretOperationContextV1;
}>) {
  return runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => {
    const catalog = readAgentCatalogSnapshot();
    const agents = resolveAgentFoundSkillSources(catalog);
    const account = createCliApprovalsArtifactStore({ credentials: input.credentials, serverId: input.serverId, serverHttpBaseUrl: input.serverHttpBaseUrl,
      ...(input.operationContext ? { operationContext: input.operationContext } : {}) });
    return createMachineSkillActions({ store: account.promptLibraryStore, readPluginSkills: account.readPluginSkills,
      target: input.target, libraryServerIdentityId: input.target.serverIdentityId,
      homeDirectory: homedir(), happierHomeDirectory: configuration.happyHomeDir, agents,
      readInstalledAgents: async () => {
        const snapshot = await detectCliSnapshotOnDaemonPath({ requestedCliNames: agents.map(agent => agent.agentId) });
        return agents.filter(agent => {
          const entry = snapshot.clis[agent.agentId];
          return entry && (entry.installed ?? entry.available);
        }).map(agent => agent.agentId);
      } });
  });
}
