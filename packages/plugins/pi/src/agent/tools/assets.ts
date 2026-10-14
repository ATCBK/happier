import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AgentSessionMcpLaunchConfig, AgentSessionNativeToolBridgeConfig, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeAtomicTextFileIfChanged, writeSecureTempTextFileSync } from '@happier-dev/plugin-sdk/fs';

import { buildPiHappierToolsExtensionSource } from './extensionSource.js';

export type PreparedPiHappierToolsExtension = Readonly<{
  extensionPath: string;
  configPath: string;
  toolNames: readonly string[];
  dispose(): Promise<void>;
}>;

export async function preparePiHappierToolsExtension(params: Readonly<{
  agentDir: string;
  mcpServers?: Readonly<Record<string, AgentSessionMcpLaunchConfig>>;
  mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
}> & (Readonly<{ config: AgentSessionNativeToolBridgeConfig; directory?: never }>
  | Readonly<{ config?: never; directory: string }>)): Promise<PreparedPiHappierToolsExtension> {
  const config = params.config ?? { v: 1, directory: params.directory, systemPrompt: '', tools: [] };
  const extensionPath = join(
    params.agentDir,
    'extensions',
    'happier-pi-tools-bridge',
    'happier-pi-tools-bridge.js',
  );
  await writeAtomicTextFileIfChanged({
    path: extensionPath,
    contents: buildPiHappierToolsExtensionSource(),
    mode: 0o600,
  });
  const configPath = writeSecureTempTextFileSync({
    prefix: 'happier-pi-tools',
    suffix: '.json',
    contents: `${JSON.stringify({ ...config, mcpServers: params.mcpServers ?? {},
      ...(params.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: params.mcpServersStrictMode } : {}),
      ...(params.mcpToolPolicy ? { mcpToolPolicy: params.mcpToolPolicy } : {}) })}\n`,
  });
  return Object.freeze({
    extensionPath,
    configPath,
    toolNames: Object.freeze(config.tools.map((tool) => tool.name)),
    async dispose() {
      await rm(dirname(configPath), { recursive: true, force: true });
    },
  });
}
