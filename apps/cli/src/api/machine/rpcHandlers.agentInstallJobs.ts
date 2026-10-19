import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallListRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { getDaemonAgentInstallJobOwner, type AgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import type { RpcHandlerRegistrar, RpcHandlerContext } from '../rpc/types';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { refreshActiveAcpCatalog, refreshDaemonAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readStoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

export function registerMachineAgentInstallJobRpcHandlers(params: { rpcHandlerManager: RpcHandlerRegistrar; owner?: AgentInstallJobOwner }): void {
  const owner = params.owner ?? getDaemonAgentInstallJobOwner();
  const invalid = { ok: false as const, errorCode: 'invalid_request' as const, error: 'Invalid agent install job request' };
  const unavailable = { ok: false as const, errorCode: 'install_unavailable' as const,
    error: 'Configured Agent jobs require current Account admission.' };
  const admittedAccount = async (context?: RpcHandlerContext): Promise<string | null> => {
    if (!context?.machineAdmission || context.signal.aborted
      || !context.verifyMachineAdmissionCurrent) return null;
    try { return await context.verifyMachineAdmissionCurrent() && !context.signal.aborted ? context.machineAdmission.actorAccountId : null; }
    catch { return null; }
  };
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_START, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallStartRequestSchema.safeParse(raw);
    if (parsed.success && parsed.data.definitionId !== undefined) {
      const accountId = await admittedAccount(context);
      if (!accountId) return unavailable;
      if (accountId !== context!.machineAdmission!.custodianAccountId) {
        const requester = readRequesterAccountActionContext(context?.callerInputAuthorization);
        const operation = requester?.savedSecretOperationContext ?? context?.requesterSessionBootstrap?.savedSecretOperationContext;
        const operationAccountId = requester?.authorization.binding.accountId ?? context?.requesterSessionBootstrap?.attribution.accountId;
        if (!operation || operationAccountId !== accountId || !await operation.isCurrent()) return unavailable;
        const catalog = await runWithServerHttpBaseUrl(operation.serverHttpBaseUrl, () => refreshActiveAcpCatalog({
          credentials: operation.credentials, operationContext: operation, signal: context?.signal,
        }));
        if (catalog.status !== 'ready' || !await operation.isCurrent() || await admittedAccount(context) !== accountId) return unavailable;
        return owner.start(parsed.data, { accountId, catalog });
      }
      if (parsed.data.intent !== 'uninstall') {
        // Registry Add writes the Account row before START. The custodian's
        // background observation can still predate that write, just like a guest's.
        // Capture the pin through the same hydration owner before admitting work.
        const credentials = await readStoredCredentials();
        if (!credentials || readAccountIdFromToken(credentials.token) !== accountId
          || getActiveAccountSettingsSnapshot()?.scopeKey !== resolveAccountSettingsScopeKey(credentials)) return unavailable;
        const catalog = await refreshDaemonAcpCatalog({ credentials, signal: context?.signal });
        if (await admittedAccount(context) !== accountId) return unavailable;
        return owner.start(parsed.data, { accountId, catalog });
      }
    }
    return parsed.success ? await owner.start(parsed.data) : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallReadRequestSchema.safeParse(raw);
    const accountId = await admittedAccount(context);
    if (parsed.success && owner.isDefinitionJob(parsed.data.jobId) && !accountId) return unavailable;
    return parsed.success ? await owner.read(parsed.data, accountId ?? '') : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallCancelRequestSchema.safeParse(raw);
    const accountId = await admittedAccount(context);
    if (parsed.success && owner.isDefinitionJob(parsed.data.jobId) && !accountId) return unavailable;
    return parsed.success ? await owner.cancel(parsed.data, accountId ?? '') : invalid;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST, async (raw: unknown, context?: RpcHandlerContext) => {
    const parsed = DaemonAgentInstallListRequestSchema.safeParse(raw);
    if (!parsed.success) return invalid;
    return owner.list(await admittedAccount(context) ?? '');
  });
}
