import { HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD, HostPrivatePluginInstallDecisionV1Schema } from '@happier-dev/protocol/marketplace/internal';
import { decideDaemonPluginChange } from '@/daemon/controlClient';
import type { RpcHandlerRegistrar } from '../rpc/types';

/** Installation consent stays daemon-owned after browsing moves to registries. */
export function registerMachinePluginInstallDecisionRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  deps?: Readonly<{ decidePluginChange?: typeof decideDaemonPluginChange }>;
}>): void {
  params.rpcHandlerManager.registerHandler(HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD, async (raw: unknown) => {
    const parsed = HostPrivatePluginInstallDecisionV1Schema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, errorCode: 'invalid_request' as const, error: 'invalid_request' };
    const decidePluginChange = params.deps?.decidePluginChange ?? decideDaemonPluginChange;
    return parsed.data.decision === 'cancel'
      ? decidePluginChange({ pendingChangeId: parsed.data.pendingChangeId, decision: 'cancel' })
      : decidePluginChange({ pendingChangeId: parsed.data.pendingChangeId, decision: 'installAndTrust', optionalSelections: parsed.data.optionalSelections });
  });
}
