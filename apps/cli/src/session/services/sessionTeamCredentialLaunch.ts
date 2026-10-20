import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ActionExecutorDeps, ProviderBrokerApplicationBindingV1, TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol';
import { TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';
import { mergeSessionTeamCredentialBindingIntents, readSpawnConnectedServicesTeamResources,
  resolvePurposeTeamCredentialBindingIntents, type PurposeTeamResourceSelectionForSession } from './spawnConnectedServicesDefaults';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn,
  type AgentSpawnPurposeContributions } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentProviderBrokerApplications, resolveManagedProviderBrokerPurpose } from '@/providers/broker/applicationProjection';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { isSameTeamCredentialBrokerApplication } from '@/providers/broker/teamCredentialModelCatalog';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

/** Runtime opens read the current resource through the same Home catalog. */
export async function readSessionTeamCredentialProviderModels(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  lease: PluginRuntimeRegistryLease;
  agentId: string;
  agentTargetKey: string;
  resourceId: string;
  teamId: string;
  signal: AbortSignal;
}>): Promise<TeamCredentialResourceCatalogEntryV1['providerModels']> {
  let cursor: string | null = null;
  do {
    const raw = await input.homeDomainAction({
      actionId: 'teams.credentials.entitled.list', input: { teamId: input.teamId, ...(cursor ? { cursor } : {}) },
      context: { surface: 'cli' }, signal: input.signal,
    });
    const parsed = TeamCredentialResourceEntitledPageV1Schema.parse(raw);
    const resource = parsed.resources.find(candidate => candidate.id === input.resourceId);
    if (resource) return resource.providerModels;
    cursor = parsed.nextCursor;
  } while (cursor);
  return [];
}

export type NormalizedSessionTeamCredentialLaunch = Readonly<{
  options: SpawnSessionOptions;
  teamModelRow: TeamCredentialResourceCatalogEntryV1['providerModels'][number] | null;
}>;

export class SessionTeamCredentialLaunchUnavailableError extends Error {
  readonly code = 'team_credential_provider_selection_not_current';
  constructor() { super('team_credential_provider_selection_not_current'); }
}

/** Reads source-owned model rows through the one paginated recipient transport.
 * Applications come from the worker's leased Agent/Provider projection, never a
 * personal connection or a model-id-to-Provider guess. */
export async function readSessionTeamCredentialResourceCatalog(input: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  applications: readonly ProviderBrokerApplicationBindingV1[];
  teamIds?: readonly string[];
  signal?: AbortSignal;
}>): Promise<readonly TeamCredentialResourceCatalogEntryV1[]> {
  let teamIds = input.teamIds;
  if (!teamIds) {
    const discovered: string[] = [];
    let cursor: string | null = null;
    do {
      const raw = await input.homeDomainAction({
        actionId: 'teams.list',
        input: { v: 1, scope: 'member', archived: 'active', ...(cursor ? { cursor } : {}) },
        context: { surface: 'cli' },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const parsed = TeamsPageV1Schema.safeParse(raw);
      if (!parsed.success) throw new SessionTeamCredentialLaunchUnavailableError();
      discovered.push(...parsed.data.items.map(team => team.id));
      cursor = parsed.data.nextCursor;
    } while (cursor);
    teamIds = discovered;
  }
  const resourcesById = new Map<string, TeamCredentialResourceCatalogEntryV1>();
  for (const application of input.applications.length > 0 ? input.applications : [undefined]) {
    input.signal?.throwIfAborted();
    const resources = await readSpawnConnectedServicesTeamResources({
      homeDomainAction: input.homeDomainAction, teamIds, ...(application ? { application } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!resources) throw new SessionTeamCredentialLaunchUnavailableError();
    for (const resource of resources) {
      const prior = resourcesById.get(resource.id);
      if (prior && (prior.teamId !== resource.teamId || prior.resourceRevision !== resource.resourceRevision)) {
        throw new SessionTeamCredentialLaunchUnavailableError();
      }
      const basis = resource.providerModels.some(model => model.availability === 'available') ? resource : prior ?? resource;
      resourcesById.set(resource.id, { ...basis, providerModels: [...(prior?.providerModels ?? []), ...resource.providerModels] });
    }
  }
  return [...resourcesById.values()];
}

export async function normalizeSessionTeamCredentialLaunch(input: Readonly<{
  options: SpawnSessionOptions;
  agentId: string;
  agentTargetKey: string;
  contributions: AgentSpawnPurposeContributions & Pick<ResolvedContributionRegistry, 'providersByContributionKey'>;
  applications: readonly ProviderBrokerApplicationBindingV1[];
  readCatalog(): Promise<readonly TeamCredentialResourceCatalogEntryV1[]>;
}>): Promise<NormalizedSessionTeamCredentialLaunch> {
  const { options } = input;
  const explicitModelBinding = options.teamCredentialBindings?.find(binding => binding.slot.kind === 'provider_model');
  const declarations = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
    agentId: input.agentId, contributions: input.contributions,
  });
  const selectedPurposes = (declarations?.authorizedPurposes ?? []).flatMap(scope => (
    scope.serviceRefs.flatMap(service => {
      const selection = options.connectedServices?.bindingsByServiceId[buildQualifiedPluginContributionKey(service)];
      return selection?.source === 'team_resource' ? [{ scope, selection }] : [];
    })
  ));
  if (selectedPurposes.length === 0 && (!explicitModelBinding || explicitModelBinding.resourceId === null)) {
    return { options, teamModelRow: null };
  }
  if (options.modelSelection && options.modelSelection.ref.agentTargetKey !== input.agentTargetKey) {
    throw new SessionTeamCredentialLaunchUnavailableError();
  }
  const resources = await input.readCatalog();
  const fresh = !options.existingSessionId && !options.resume;
  const purposeSelections: PurposeTeamResourceSelectionForSession[] = selectedPurposes.map(({ scope, selection }) => {
    const resource = resources.find(candidate => candidate.id === selection.resourceId);
    if (!resource) throw new SessionTeamCredentialLaunchUnavailableError();
    return { purpose: scope.purpose, services: scope.serviceRefs, selection, teamId: resource.teamId };
  });
  let teamCredentialBindings = options.teamCredentialBindings;
  if (fresh && purposeSelections.length > 0) {
    try {
      teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
        explicit: teamCredentialBindings,
        admitted: resolvePurposeTeamCredentialBindingIntents({
          teamResourceSelections: purposeSelections, teamCredentialResourceCatalog: { resources },
        }),
      });
    } catch {
      throw new SessionTeamCredentialLaunchUnavailableError();
    }
  }
  const normalizedOptions = teamCredentialBindings ? { ...options, teamCredentialBindings } : options;
  // Explicit model-source choices win. Purpose-bound credentials for other
  // integrations cannot replace a native clear or a personal Provider route.
  if (explicitModelBinding?.resourceId === null || options.modelSelection?.ref.providerConnectionId != null) {
    return { options: normalizedOptions, teamModelRow: null };
  }
  const registry = { providersByContributionKey: input.contributions.providersByContributionKey };
  const consumer = declarations?.purposes[0]?.consumer;
  const relevanceApplications = consumer ? projectAgentProviderBrokerApplications({
    registry,
    agentTargetKey: buildBackendTargetKeyV2({ kind: 'agent', identity: consumer }),
    acceptedProtocols: [...new Set([...registry.providersByContributionKey.values()]
      .flatMap(provider => provider.definition.endpointTemplates.map(endpoint => endpoint.protocol)))],
  }) : [];
  const modelSourceResources = new Set(selectedPurposes.flatMap(({ scope, selection }) => (
    selection.deliveryMode === 'brokered' && relevanceApplications.some(application => (
      scope.serviceRefs.some(service => resolveManagedProviderBrokerPurpose({
        registry, application, service,
      }) !== null)
    )) ? [selection.resourceId] : []
  )));
  if (!explicitModelBinding && (!fresh || modelSourceResources.size === 0)) {
    return { options: normalizedOptions, teamModelRow: null };
  }
  if (!explicitModelBinding && modelSourceResources.size !== 1) throw new SessionTeamCredentialLaunchUnavailableError();
  const resourceId = explicitModelBinding?.resourceId ?? modelSourceResources.values().next().value;
  const model = options.modelSelection?.ref;
  if (!model || !resourceId) throw new SessionTeamCredentialLaunchUnavailableError();
  const deliveryMode = explicitModelBinding && explicitModelBinding.resourceId !== null
    ? explicitModelBinding.deliveryMode : 'brokered';
  const resource = resources.find(candidate => candidate.id === resourceId);
  if (!resource) throw new SessionTeamCredentialLaunchUnavailableError();
  if (explicitModelBinding && explicitModelBinding.resourceId !== null
    && ((explicitModelBinding.teamId !== undefined && explicitModelBinding.teamId !== resource.teamId)
      || (fresh && explicitModelBinding.expectedResourceRevision !== resource.resourceRevision))) {
    throw new SessionTeamCredentialLaunchUnavailableError();
  }
  const row = resource.providerModels.find(candidate => (
    candidate.availability === 'available'
    && candidate.selection.resourceId === resourceId
    && candidate.selection.teamId === resource.teamId
    && candidate.selection.expectedResourceRevision === resource.resourceRevision
    && candidate.selection.deliveryMode === deliveryMode
    && candidate.selection.agentTargetKey === model.agentTargetKey
    && candidate.selection.modelId === model.modelId
    && input.applications.some(application => isSameTeamCredentialBrokerApplication(application, candidate.application))
  ));
  if (!row) throw new SessionTeamCredentialLaunchUnavailableError();
  if (!explicitModelBinding) teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
    explicit: teamCredentialBindings,
    admitted: [{ v: 1, slot: { kind: 'provider_model' }, resourceId,
      teamId: row.selection.teamId, expectedResourceRevision: row.selection.expectedResourceRevision, deliveryMode }],
  });
  return { options: teamCredentialBindings ? { ...options, teamCredentialBindings } : options, teamModelRow: row };
}
