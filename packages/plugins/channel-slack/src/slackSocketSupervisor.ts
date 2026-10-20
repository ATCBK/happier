import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConversationProviderConnectionReconciliationSnapshotV1, ConversationProviderConnectionStopResultV1 } from '@happier-dev/channels-protocol/v1';

/** Inert test-first scaffold; dependency admission blocked RED, so this is not registered. */
export function createSlackSocketSupervisor() {
  return {
    async run(_context: BackgroundServiceContext): Promise<void> {},
    invalidateConnections(): void {},
    async runWorkerAttempt(_snapshot: ConversationProviderConnectionReconciliationSnapshotV1, _context: PluginInvocationContext): Promise<void> {},
    async stop(_input: unknown, _context: PluginInvocationContext): Promise<ConversationProviderConnectionStopResultV1> { return { kind: 'notRunning' }; },
    async dispose(): Promise<void> {},
  };
}
