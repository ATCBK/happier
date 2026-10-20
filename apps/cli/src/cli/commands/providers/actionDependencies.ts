import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import type { ProviderActionIdV1 } from '@happier-dev/protocol/providers/providerActionIdsV1';
import {
  PROVIDER_ACTION_OUTPUT_SCHEMAS_V1,
  PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1,
  PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1,
} from '@happier-dev/protocol/providers/providerActionsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DaemonProviderConnectionMutationResponseV1Schema, DaemonProviderModelSettingsMutationResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import type { ProviderSavedModelsRpcResult } from '@/providers/probe/rpc';
import { ProviderCliError, type ProviderCliDependencies, type ProviderCliModelRow } from './types';

export function unwrapProviderSavedModelsRpcResult<TResult extends
  | Pick<Extract<ProviderSavedModelsRpcResult, { status: 'success' }>, 'status' | 'models'>
  | Extract<ProviderSavedModelsRpcResult, { status: 'error' }>,
>(result: TResult): readonly ProviderCliModelRow[] {
  if (result.status === 'error') {
    throw new ProviderCliError(result.error.code, `Provider catalog failed: ${result.error.code}`, result.error);
  }
  return result.models;
}

export type ProviderCliActionExecute = (
  actionId: ProviderActionIdV1,
  input: unknown,
  options?: Readonly<{
    signal?: ActionExecutorContext['signal'];
    preparedSavedSecret?: Awaited<ReturnType<ProviderCliDependencies['createSavedSecret']>>;
  }>,
) => Promise<ActionExecuteResult>;

export function routeProviderCliActions(
  deps: Omit<ProviderCliDependencies, 'connections' | 'probe' | 'models' | 'loadModel' | 'mutateModelSettings'>,
  execute: ProviderCliActionExecute,
): ProviderCliDependencies {
  const run = async (id: ProviderActionIdV1, input: unknown,
    options?: Parameters<ProviderCliActionExecute>[2]) => {
    const result = await execute(id, input, options);
    if (!result.ok) throw new ProviderCliError(result.errorCode, result.error, result.details);
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) throw new ProviderCliError('approval_required', 'Approval requested', approval.data);
    return result.result;
  };
  const mutation = async (input: Parameters<ProviderCliDependencies['connections']['update']>[0]
    | Parameters<ProviderCliDependencies['connections']['setEnabled']>[0]
    | Parameters<ProviderCliDependencies['connections']['setEndpointOverride']>[0]
    | Parameters<ProviderCliDependencies['connections']['bindSecret']>[0]) => {
    const { preparedSavedSecret, ...operand } = 'preparedSavedSecret' in input ? input : { ...input, preparedSavedSecret: undefined };
    const result = DaemonProviderConnectionMutationResponseV1Schema.parse(await run(
      PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[input.action], operand,
      preparedSavedSecret ? { preparedSavedSecret } : undefined));
    if (result.status === 'error') return result;
    if ('connection' in result) return { status: 'success' as const, ...result.connection };
    throw new ProviderCliError('provider_rpc_response_invalid', 'Provider mutation returned no connection');
  };
  return {
    ...deps,
    connections: {
      describe: async input => PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.connections.describe']
        .parse(await run('providers.connections.describe', input)),
      previewCreateContribution: async input => {
        const described = PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.connections.describe'].parse(await run(
          'providers.connections.describe', { machineId: input.machineId, authoringPreview: {
            connectionId: input.connectionId,
            contributionKey: input.contributionKey,
            displayName: input.displayName ?? null,
            selectedCandidateId: input.selectedCandidateId ?? null,
            ...(input.endpointOverrides ? { endpointOverrides: input.endpointOverrides } : {}),
          } },
        ));
        if (described.status === 'error') return described;
        const preview = described.authoringPreview;
        if (!preview) throw new ProviderCliError('provider_rpc_response_invalid', 'Provider authoring returned no preview');
        return { status: 'success', connectionId: preview.connectionId, created: preview.created, authoringPreview: preview };
      },
      create: async input => {
        const { preparedSavedSecret, ...operand } = input;
        const result = DaemonProviderConnectionMutationResponseV1Schema.parse(await run(
          PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1[input.action], operand,
          preparedSavedSecret ? { preparedSavedSecret } : undefined));
        if (result.status === 'error') return result;
        if ('connection' in result) return { status: 'success', connection: result.connection, created: result.created ?? false };
        throw new ProviderCliError('provider_rpc_response_invalid', 'Provider creation returned no connection');
      },
      update: mutation,
      setEndpointOverride: mutation,
      setEnabled: mutation,
      bindSecret: mutation,
      delete: async input => {
        const result = DaemonProviderConnectionMutationResponseV1Schema.parse(await run('providers.connections.delete', input));
        if (result.status === 'error') return result;
        if ('deletedConnectionId' in result) return { status: 'success', connectionId: result.deletedConnectionId };
        throw new ProviderCliError('provider_rpc_response_invalid', 'Provider deletion returned no connection id');
      },
    },
    models: async input => unwrapProviderSavedModelsRpcResult(PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.models.list']
      .parse(await run('providers.models.list', input))),
    probe: async input => PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.probe'].parse(await run('providers.probe', input)),
    loadModel: async ({ signal, ...input }) => PROVIDER_ACTION_OUTPUT_SCHEMAS_V1['providers.models.load']
      .parse(await run('providers.models.load', { action: 'load', ...input }, { signal })),
    mutateModelSettings: async input => DaemonProviderModelSettingsMutationResponseV1Schema
      .parse(await run(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1[input.action], input)),
  };
}
