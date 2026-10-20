import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps, type ActionId } from '@happier-dev/protocol';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { CurrentProcessPluginActionExecutionAttempt } from './createDaemonPluginActionExecutor';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker,
  createCommittedContributedActionSchemaReader, createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCredentialedTargetActionCurrentIntent } from './approvals/credentialedTargetActionCurrentIntent';
import type { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import axios from 'axios';

/** Selects Account custody for the incumbent runtime and invocation owners. */
export async function executeAccountPluginAction(params: Readonly<{
  host: Parameters<typeof createCliActionExecutorHarness>[0];
  deps: ActionExecutorDeps;
  actionId: string;
  input: unknown;
  context?: ActionExecutorContext;
}>): Promise<CurrentProcessPluginActionExecutionAttempt> {
  const credentials = params.host.credentials;
  if (!credentials || !params.host.serverHttpBaseUrl) return { matched: false };
  const input = typeof params.input === 'object' && params.input !== null ? params.input : null;
  const ref = input && 'action' in input && typeof input.action === 'object' && input.action !== null
    ? input.action : null;
  const metadataId = input && (params.actionId === 'action.spec.get' && 'id' in input ? input.id
    : params.actionId === 'action.options.resolve' && 'actionId' in input ? input.actionId : null);
  const identity = parseQualifiedPluginActionId(typeof metadataId === 'string' ? metadataId : params.actionId);
  const pluginId = ref && 'pluginId' in ref && typeof ref.pluginId === 'string' ? ref.pluginId
    : identity?.pluginId;
  const localId = ref && 'localId' in ref && typeof ref.localId === 'string' ? ref.localId
    : identity?.localId;
  // Discovery and invocation use the incumbent catalog; Account custody never
  // permits evaluating a Machine handler from these bytes.
  const search = params.actionId === 'action.spec.search';
  if (!pluginId && !search) return { matched: false };
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const isCurrent = () => lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
    && !params.context?.signal?.aborted;
  if (params.host.isCredentialCurrent && !await params.host.isCredentialCurrent()) return { matched: true,
    result: { ok: false, errorCode: 'plugin_action_generation_retired', error: 'plugin_action_generation_retired' } };
  return await runWithServerHttpBaseUrl(params.host.serverHttpBaseUrl, async () => {
    const registry = await resolveExecutablePluginRuntimeRegistry({
      ...(params.host.happyHomeDir ? { happyHomeDir: params.host.happyHomeDir } : {}),
      ...(params.context?.signal ? { signal: params.context.signal } : {}),
      accountExecution: { credentials, serverUrl: params.host.serverHttpBaseUrl!, isCurrent,
        ...(params.context?.executionRunTargetMachineId ? { machineId: params.context.executionRunTargetMachineId } : {}) },
    }).catch((error: unknown) => {
      params.context?.signal?.throwIfAborted();
      // Source transport failure grants nothing. The existing dispatcher must
      // independently prove current Machine placement before it can proceed.
      if (axios.isAxiosError(error) && (!error.response || error.response.status === 404 || error.response.status === 501)) return null;
      throw error;
    });
    if (!registry) return search ? { matched: false } : { matched: false, accountSelectionUnavailable: true };
    try {
      const selection = pluginId ? registry.readAccountExecutionSelection?.(pluginId) : null;
      if (selection?.kind === 'unavailable' && selection.code !== 'plugin_account_execution_unavailable') return { matched: true,
        result: { ok: false, errorCode: selection.code, error: selection.code } };
      if (!search && !registry.contributes.actions.some(action => action.identity?.pluginId === pluginId
        && action.identity.localId === localId && typeof action.definition.execution === 'object'
        && action.definition.execution !== null && 'target' in action.definition.execution
        && action.definition.execution.target === 'account')) return { matched: false, accountSelectionUnavailable: true };
      // Borrow the same finite runtime for nested schema/invocation reads; the
      // owning invocation disposes it once, after approval and settlement.
      const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
      const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => lease });
      const executor = createActionExecutor({ ...params.deps,
        ...createRegistryInputTypeDeps(registry),
        listContributedActionDefinitions: list,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
        invokeContributedAction: createCommittedContributedActionInvoker({
          acquireRuntimeRegistryLease: async () => lease,
          requestCurrentIntent: createCredentialedTargetActionCurrentIntent(credentials),
        }),
      });
      return { matched: true, result: await executor.execute(params.actionId as ActionId, params.input, params.context) };
    } finally { await registry.dispose(); }
  });
}
