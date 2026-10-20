import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { issueMcpRequestAuthCapability, type McpRequestAuthIssuanceContext } from '@/mcp/runtime/issueMcpRequestAuthCapability';
import type { McpRequestAuthCapability, McpRequestAuthPort } from '@/mcp/runtime/mcpRequestAuth';

export type McpTestRequestAuthAttachment = McpRequestAuthCapability & Readonly<{ cleanup(): Promise<void> }>;
export type IssueMcpTestRequestAuth = (
  input: Parameters<McpRequestAuthPort['open']>[0],
  operationContext: SavedSecretOperationContextV1 | null,
  ingress?: RpcHandlerContext,
) => Promise<McpTestRequestAuthAttachment>;

/** Finite Machine Test borrows the daemon's incumbent issuer and descriptor retirement. */
export function createDaemonMcpRequestAuthForTest(params: Readonly<{
  credentials: StoredCredentials;
  materializationBaseDir: string;
  establishedOwner: McpRequestAuthIssuanceContext['establishedOwner'];
  activatePurposeBindings: McpRequestAuthIssuanceContext['activatePurposeBindings'];
  registry: McpRequestAuthIssuanceContext['registry'];
  getHttpPort(): number;
  isCurrent(): boolean;
}>): IssueMcpTestRequestAuth {
  return async (input, operationContext, ingress) => {
    const signal = ingress?.signal ?? new AbortController().signal;
    const scopeKey = resolveAccountSettingsScopeKey(params.credentials);
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const readSnapshot = operationContext?.readSnapshot ?? getActiveAccountSettingsSnapshot;
    const isCurrent = () => params.isCurrent() && !signal.aborted
      && getActiveAccountSettingsSnapshotLifetimeToken() === lifetime
      && getActiveAccountSettingsSnapshot()?.scopeKey === scopeKey
      && readSnapshot()?.scopeKey === scopeKey
      && (!operationContext || operationContext.credentials.token === params.credentials.token);
    const assertCurrent = async (requestSignal: AbortSignal) => {
      requestSignal.throwIfAborted();
      if (!isCurrent() || operationContext && !await operationContext.isCurrent()
        || ingress?.verifyMachineAdmissionCurrent && !await ingress.verifyMachineAdmissionCurrent()) {
        throw new Error('mcp_request_auth_not_active');
      }
      requestSignal.throwIfAborted();
      if (!isCurrent()) throw new Error('mcp_request_auth_not_active');
    };
    let retire: (() => Promise<void>) | undefined;
    const capability = await issueMcpRequestAuthCapability(input, {
      materializationBaseDir: params.materializationBaseDir,
      establishedOwner: params.establishedOwner,
      activatePurposeBindings: params.activatePurposeBindings,
      registry: params.registry, httpPort: params.getHttpPort(),
      readAccountSettingsSnapshot: readSnapshot, isCurrent, assertCurrent,
      ...(operationContext ? { operationContext } : {}),
      registerLifetimeCleanup: cleanup => { retire = cleanup; return () => undefined; },
    }, signal);
    return { ...capability, cleanup: async () => { await retire?.(); } };
  };
}
