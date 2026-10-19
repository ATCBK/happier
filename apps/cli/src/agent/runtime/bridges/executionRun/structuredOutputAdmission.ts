import { AgentModelsProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { invokeCliPreflightMethod, type CliProbeDependencies } from '@/capabilities/probes/agentPreflight';
import { withAgentPreflightCatalog } from '@/capabilities/probes/withAgentPreflightCatalog';
import { resolveExecutionRunRuntimeBackendId } from './backendTargets';
import type { ExecutionRunManagerStartParams } from './executionRunTypes';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { CreateAgentInvocationServices } from '@/plugins/runtime/invocation/services/types';

type ModelAdmissionParams = Pick<ExecutionRunManagerStartParams,
  'backendTarget' | 'modelId' | 'modelSelection' | 'teamCredentialModel' | 'cwd'
  | 'accountSettings' | 'promptCredentials' | 'runtimeDescriptorV1' | 'readNativeOfferedModel'
  | 'connectedServices' | 'secretReferenceOverlay'>;

/** One probe owner serves both daemon-retained and ordinary native admission. */
export async function readNativeExecutionRunOfferedModel(params: Parameters<NonNullable<ExecutionRunManagerStartParams['readNativeOfferedModel']>>[0]
  & Pick<ExecutionRunManagerStartParams, 'accountSettings' | 'promptCredentials'> & Readonly<{
    catalogEntry?: AgentCatalogEntry | null;
    runtimeCacheKey?: string;
    registrySnapshot?: ResolvedContributionRegistry;
    signal?: AbortSignal;
    createAgentInvocationServices?: CreateAgentInvocationServices;
    isCurrent?: () => boolean;
    preflightDependencies?: Pick<CliProbeDependencies, 'createApiClient' | 'activatePurposeBindings'>;
  }>) {
  // The same executable occurrence may probe for more than one Session Account.
  const runtimeCacheKey = params.promptCredentials
    ? JSON.stringify([params.runtimeCacheKey ?? null, resolveAccountSettingsScopeKey(params.promptCredentials)])
    : params.runtimeCacheKey;
  const agentId = resolveExecutionRunRuntimeBackendId(params.backendTarget);
  const response = await invokeCliPreflightMethod(agentId, 'probeModels', {
    backendTarget: params.backendTarget, cwd: params.cwd, runtimeDescriptorV1: params.runtimeDescriptorV1,
    connectedServices: params.connectedServices,
    secretReferenceOverlay: params.secretReferenceOverlay,
  }, {
    ...params.preflightDependencies,
    createApiClient: params.preflightDependencies?.createApiClient
      ?? (async credentials => (await import('@/api/api')).ApiClient.create(credentials)),
    accountContext: { credentials: params.promptCredentials ?? null, accountSettings: params.accountSettings ?? null },
    agentCatalogEntry: params.catalogEntry, agentRuntimeCacheKey: runtimeCacheKey,
    agentRegistrySnapshot: params.registrySnapshot,
    createAgentInvocationServices: params.createAgentInvocationServices,
    isAgentRegistryCurrent: params.isCurrent,
  }, { signal: params.signal });
  if (!response.ok) return undefined;
  const catalog = AgentModelsProbeObservationSchema.safeParse(response.result);
  return !catalog.success || catalog.data.agentId !== agentId || catalog.data.source === 'unavailable'
    ? undefined : catalog.data.availableModels.find(model => model.id === params.modelId);
}

/** Admission consumes the same actual offered-model truth published by the probe. */
export async function readExecutionRunOfferedModel(params: ModelAdmissionParams) {
  const modelId = params.teamCredentialModel?.modelId ?? params.modelSelection?.modelId ?? params.modelId ?? 'default';
  // A Provider/Team model must supply its own evidence; a native catalog cannot
  // grant that distinct source the Agent's native JSON contract.
  if (!params.teamCredentialModel && !params.modelSelection?.providerConnectionId) {
    try {
      const request = { backendTarget: params.backendTarget, modelId, cwd: params.cwd ?? process.cwd(),
        ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
        ...(params.secretReferenceOverlay ? { secretReferenceOverlay: params.secretReferenceOverlay } : {}),
        ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}) };
      if (params.readNativeOfferedModel) {
        const model = await params.readNativeOfferedModel(request);
        return model?.id === modelId ? model : undefined;
      }
      const agentId = resolveExecutionRunRuntimeBackendId(params.backendTarget);
      return await withAgentPreflightCatalog({ agentId }, context => readNativeExecutionRunOfferedModel({
        ...params, ...request, ...context,
      }));
    } catch {
      // An unavailable catalog is not evidence of structured publication support.
      return undefined;
    }
  }
  return undefined;
}

export async function assertExecutionRunStructuredOutputModelAllowed(params: ModelAdmissionParams): Promise<void> {
  const modelId = params.teamCredentialModel?.modelId ?? params.modelSelection?.modelId ?? params.modelId ?? 'default';
  const support = (await readExecutionRunOfferedModel(params))?.capabilities?.structuredOutput ?? 'unknown';
  if (support !== 'supported') {
    const code = 'model_structured_output_unsupported';
    throw Object.assign(new Error('The selected model does not establish structured JSON output support.'), {
      code,
      rpcErrorCode: code,
      details: { modelId, structuredOutput: support },
    });
  }
}
