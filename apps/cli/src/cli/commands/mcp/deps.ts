import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { resolveLiveDaemonControlTargetForServer } from '@/daemon/multiDaemon';
import {
  fetchServerFeaturesSnapshot,
  observeServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';

export type McpCommandDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  readStoredCredentials: () => Promise<StoredCredentials | null>;
  bootstrapAccountSettingsContext: typeof bootstrapAccountSettingsContext;
  ensureMachineIdForCredentials: typeof ensureMachineIdForCredentials;
  createExternalMcpServer?: typeof createExternalMcpServer;
  readDaemonPluginCatalog?: typeof readDaemonPluginCatalog;
  resolveLiveDaemonControlTargetForServer?: typeof resolveLiveDaemonControlTargetForServer;
  fetchServerFeaturesSnapshot?: typeof fetchServerFeaturesSnapshot;
  observeServerFeaturesSnapshot?: typeof observeServerFeaturesSnapshot;
  connectMcpStdio: (server: Pick<McpServer, 'connect'>) => Promise<void>;
}>;

export function resolveMcpCommandDeps(overrides?: Partial<McpCommandDeps>): McpCommandDeps {
  return {
    env: overrides?.env ?? process.env,
    readStoredCredentials: overrides?.readStoredCredentials ?? readStoredCredentials,
    bootstrapAccountSettingsContext: overrides?.bootstrapAccountSettingsContext ?? bootstrapAccountSettingsContext,
    ensureMachineIdForCredentials: overrides?.ensureMachineIdForCredentials ?? ensureMachineIdForCredentials,
    createExternalMcpServer: overrides?.createExternalMcpServer,
    readDaemonPluginCatalog: overrides?.readDaemonPluginCatalog ?? readDaemonPluginCatalog,
    resolveLiveDaemonControlTargetForServer:
      overrides?.resolveLiveDaemonControlTargetForServer ?? resolveLiveDaemonControlTargetForServer,
    fetchServerFeaturesSnapshot: overrides?.fetchServerFeaturesSnapshot ?? fetchServerFeaturesSnapshot,
    observeServerFeaturesSnapshot:
      overrides?.observeServerFeaturesSnapshot ?? observeServerFeaturesSnapshot,
    connectMcpStdio: overrides?.connectMcpStdio ?? (async (server) => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }),
  };
}
