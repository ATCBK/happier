import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1,
    MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { readMcpPluginItemMetadataFromProjectionV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { randomUUID } from '@/platform/randomUUID';
import { readMcpServerCatalogInContext, mutateMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { LazyActionAccountContext } from './actionAccountContext';
import { createUiConnectedServiceAction } from './connectedServiceActionDeps';
import { resolveUiAccountActionFallbackMachineId } from './accountActionDeps';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { storage } from '@/sync/domains/state/storageStore';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readMcpServerToolAgentFacts } from './mcpServerToolAgentFacts';
import { readInstalledMachineAgentIds } from '@/sync/domains/capabilities/reach/installedMachineAgents';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';

/** Reuse the catalog and RPC owners within the Action host's captured Account lifetime. */
export function createUiMcpServerActionExecuteV1(account: LazyActionAccountContext,
    connectedServiceAction = createUiConnectedServiceAction(account), dependencies: Pick<ActionExecutorDeps,
        'registryActionExecute' | 'personalSavedSecretActionExecute'> = {}): NonNullable<ActionExecutorDeps['mcpServerAction']> {
    return async request => {
        const { context } = request;
        const retired = new AbortController();
        const subscription = account.accountLifetime.onRetire(() => retired.abort());
        const cancellation = mergeAbortSignals([retired.signal, context.signal]);
        const assertCurrent = () => { account.assertCurrent(); cancellation.signal.throwIfAborted(); };
        try {
            assertCurrent();
            const readPluginItems = async () => {
                assertCurrent();
                const machineId = resolveUiAccountActionFallbackMachineId(account);
                if (!machineId) return null;
                const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
                const inputs = await loadDaemonMergedProjectionInputs({ machineId, serverId: account.serverId, accountLifetime: account.accountLifetime });
                assertCurrent();
                if (!inputs?.pluginProjectionV2) return null;
                return readMcpPluginItemMetadataFromProjectionV1(inputs.pluginProjectionV2);
            };
            return await createMcpServerActionExecuteV1({
                registryActionExecute: dependencies.registryActionExecute,
                personalSavedSecretActionExecute: dependencies.personalSavedSecretActionExecute,
                readImportLink: async url => {
                    assertCurrent();
                    const target = new URL(url);
                    if (target.protocol !== 'https:' || target.username || target.password) throw Object.assign(new Error('Invalid config URL'), { code: 'invalid_registry_input' });
                    const { runtimeFetch } = await import('@/utils/system/runtimeFetch');
                    const response = await runtimeFetch(target.href, { signal: cancellation.signal, redirect: 'error' });
                    if (!response.ok) throw Object.assign(new Error('Config link unavailable'), { code: 'registry_unavailable' });
                    const text = await response.text(); assertCurrent(); return text;
                },
                readPluginItems,
                connectedServiceAction,
                resolveAdministrationMachine: async () => {
                    assertCurrent();
                    const [{ resolveFreshMachineAdministrationExecutionTarget }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 }] = await Promise.all([
                        import('@/sync/domains/machines/administration/useTargetSelection'),
                        import('@/sync/domains/machines/administration/selectionPreferences'),
                    ]);
                    assertCurrent();
                    const selected = storage.getState().settings.machineAdministrationTargetsLocalV1[MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts] ?? null;
                    const target = resolveFreshMachineAdministrationExecutionTarget(selected, { accountScope: account.accountLifetime.scope });
                    return target && areServerProfileIdentifiersEquivalent(target.profile.id, account.serverId)
                        ? target.machine.id : resolveUiAccountActionFallbackMachineId(account);
                },
                describeConnectedService: (machineId, command) => machineRpcWithServerScope({ machineId, serverId: account.serverId,
                    accountId: account.accountId, preferScoped: true, requestId: context.actionRequestId,
                    method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
                    payload: ConnectedAccountControlCommandRequestSchema.parse({ v: 1, machineId,
                        command }),
                    authorization: context.rpcSessionAuthorization, signal: cancellation.signal,
                    operationTimeoutMs: null, onDispatched: assertCurrent }),
                ruleWriteContext: () => ({ nowMs: Date.now(), newId: randomUUID }),
                readToolAgentFacts: async () => {
                    assertCurrent();
                    const machineId = resolveUiAccountActionFallbackMachineId(account);
                    if (!machineId) return null;
                    const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
                    assertCurrent();
                    const inputs = await loadDaemonMergedProjectionInputs({ machineId, serverId: account.serverId,
                        accountLifetime: account.accountLifetime });
                    assertCurrent();
                    const projection = inputs?.pluginProjectionV2;
                    if (!projection) return null;
                    const installedAgentIds = resolveVisibleMachinesForActiveServerFromState(storage.getState(), { serverId: account.serverId })
                        .flatMap(machine => readInstalledMachineAgentIds(machine.metadata?.agentInventory,
                            machineAgentInventoryStore.read(serverAccountScopedResourceKey(account.accountLifetime.scope, 'machine-agents', machine.id))));
                    const agents = readMcpServerToolAgentFacts(projection, installedAgentIds);
                    assertCurrent();
                    return { machineId, agents };
                },
                readCatalog: async () => {
                    const snapshot = await readMcpServerCatalogInContext(account, cancellation.signal);
                    assertCurrent();
                    return snapshot;
                },
                mutate: async (change, expectedRevision) => {
                    const pluginAdmissionNeeded = change.kind === 'plugin-defaults'
                        || change.kind === 'rules-change' && change.serverIds.some(id => id.startsWith('plugin:'))
                        || change.kind === 'tools-change' && change.serverId.startsWith('plugin:');
                    const plugins = pluginAdmissionNeeded ? await readPluginItems() : [];
                    if (plugins === null) throw Object.assign(new Error('Plugin MCP catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
                    return mutateMcpServerCatalogInContext(account,
                        { change, expectedRevision, pluginItemIds: plugins.map(item => item.id) }, cancellation.signal);
                },
                machine: async ({ actionId, input, machineId }) => {
                    assertCurrent();
                    let response: unknown;
                    try {
                        response = await machineRpcWithServerScope({ machineId, serverId: account.serverId,
                            accountId: account.accountId, preferScoped: true, requestId: context.actionRequestId,
                            method: actionId === 'mcp.servers.test' ? RPC_METHODS.DAEMON_MCP_SERVERS_TEST : RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
                            payload: input, authorization: context.rpcSessionAuthorization, signal: cancellation.signal,
                            operationTimeoutMs: null, onDispatched: assertCurrent });
                    } catch (cause) {
                        const refusal = projectMcpServerActionFailureV1(cause);
                        const disposition = readRpcRequestDisposition(cause);
                        if (actionId === 'mcp.servers.test' && (disposition === 'outcomeUnknown'
                            || refusal.errorCode === 'mcp_catalog_operation_failed')) {
                            throw Object.assign(new Error('MCP test disposition'), {
                                code: disposition === 'notSent' ? 'machine_unreachable' : 'outcome_unknown' });
                        }
                        throw cause;
                    }
                    const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(response);
                    if (!parsed.success) throw Object.assign(new Error('Invalid MCP Machine receipt'), {
                        code: actionId === 'mcp.servers.test' ? 'outcome_unknown' : 'invalid_action_output' });
                    // The RPC owner retains consumed ACKs; only read disclosure
                    // depends on the invocation remaining current afterwards.
                    if (actionId === 'mcp.found.list') assertCurrent();
                    return parsed.data;
                },
            })(request);
        } catch (cause) { return projectMcpServerActionFailureV1(cause); }
        finally { subscription.dispose(); cancellation.dispose(); }
    };
}
