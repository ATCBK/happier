import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { PluginAgentAcpNativeSessionMcpConfigV2 } from '@happier-dev/protocol';
import type { AgentSessionMcpLaunchConfig, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  createSecureTempDirectorySync,
  expandHomePath,
  linkDirectoryChildren,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/plugin-sdk/fs';

type EnvLike = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;

export type NativeSessionConfigDelivery = Readonly<{
  /** Launch environment overrides that point the Agent at the session-private root. */
  env: Readonly<Record<string, string>>;
  /** Removes the session-private root. Safe to call more than once. */
  cleanup(): void;
}>;

const NO_DELIVERY: NativeSessionConfigDelivery = Object.freeze({
  env: Object.freeze({}),
  cleanup: () => {},
});

function readPlatformValue<T>(
  value: Readonly<{ posix: T; win32: T }>,
  platform: NodeJS.Platform,
): T {
  return platform === 'win32' ? value.win32 : value.posix;
}

export function resolveNativeSessionConfigPaths(params: Readonly<{
  declaration: PluginAgentAcpNativeSessionMcpConfigV2;
  env: EnvLike;
  platform: NodeJS.Platform;
}>): Readonly<{
  configRootEnvKey: string;
  configRoot: string;
  directoryPath: string;
  configPath: string;
}> {
  const configRootEnvKey = readPlatformValue(
    params.declaration.configRootEnvKey,
    params.platform,
  );
  const homeDir = resolveHomeDirFromEnvironment(params.env, params.platform);
  const declared = params.env[configRootEnvKey]?.trim() ?? '';
  const configRoot = declared
    ? expandHomePath(declared, homeDir, params.platform)
    : join(homeDir, ...readPlatformValue(
      params.declaration.homeRelativeConfigRoot,
      params.platform,
    ));
  const directoryPath = join(configRoot, params.declaration.directory);
  return Object.freeze({
    configRootEnvKey,
    configRoot,
    directoryPath,
    configPath: join(directoryPath, params.declaration.fileName),
  });
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readExistingConfig(path: string): Promise<JsonObject> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse MCP config at ${path}`, { cause: error });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Walks from the Session cwd to its enclosing repository root, matching how
 * these CLIs discover project config, and refuses to launch when a project
 * entry would shadow a Happier tool server the user cannot see.
 */
async function assertNoProjectConfigShadowsSessionServer(params: Readonly<{
  cwd: string;
  relativePaths: readonly string[];
  serversKey: string;
  sessionServerNames: readonly string[];
}>): Promise<void> {
  const sessionServerNames = new Set(params.sessionServerNames);
  const directories: string[] = [];
  let current = resolve(params.cwd);
  while (true) {
    directories.push(current);
    if (
      await pathExists(join(current, '.git'))
      || await pathExists(join(current, '.jj'))
    ) break;
    const parent = dirname(current);
    if (parent === current) {
      directories.length = 1;
      break;
    }
    current = parent;
  }
  for (const directory of directories) {
    for (const relativePath of params.relativePaths) {
      const path = join(directory, ...relativePath.split('/'));
      const config = await readExistingConfig(path);
      const configuredServers = config[params.serversKey];
      const servers = isRecord(configuredServers) ? configuredServers : {};
      for (const name of Object.keys(servers)) {
        if (!sessionServerNames.has(name)) continue;
        throw new Error(
          `Project MCP config at ${path} shadows the Session MCP server '${name}'. Rename or disable the project server before starting this Happier session.`,
        );
      }
    }
  }
}

/**
 * A server the user configured for the provider keeps reading the user's real
 * config root: the session-private root exists for this launch only and does
 * not become the child server's provider home.
 */
function withSourceConfigRoot(
  entry: unknown,
  configRootEnvKey: string,
  sourceConfigRoot: string,
): unknown {
  if (!isRecord(entry) || typeof entry.command !== 'string') return entry;
  const declaredEnv = isRecord(entry.env) ? entry.env : {};
  return {
    ...entry,
    env: { [configRootEnvKey]: sourceConfigRoot, ...declaredEnv },
  };
}

function buildSessionServerEntry(params: Readonly<{
  config: AgentSessionMcpLaunchConfig;
  constants: Readonly<Record<string, string>>;
  configRootEnvKey: string;
  sourceConfigRoot: string;
}>): JsonObject {
  return {
    command: params.config.command,
    args: [...(params.config.args ?? [])],
    env: {
      [params.configRootEnvKey]: params.sourceConfigRoot,
      ...params.config.env,
    },
    ...params.constants,
  };
}

/**
 * Composes Session MCP servers and skills into an Agent's private config root.
 * The user's provider directory is linked into a session-private root, the merged server map is written there, and the
 * Agent's config-root variable points at that root for this launch alone;
 * nothing in the user's real provider state is mutated.
 */
export async function prepareNativeSessionConfig(params: Readonly<{
  declaration: PluginAgentAcpNativeSessionMcpConfigV2;
  cwd: string;
  /** Effective launch environment: process env, launch overrides, then unsets. */
  env: EnvLike;
  mcpServers: Readonly<Record<string, AgentSessionMcpLaunchConfig>> | undefined;
  skills?: Readonly<{ subdirectory: string; delivery: AgentSessionSkillDelivery }>;
  platform?: NodeJS.Platform;
}>): Promise<NativeSessionConfigDelivery> {
  const sessionServers = params.mcpServers ?? {};
  const sessionServerNames = Object.keys(sessionServers);
  if (sessionServerNames.length === 0 && !params.skills) return NO_DELIVERY;

  const platform = params.platform ?? process.platform;
  const declaration = params.declaration;
  if (sessionServerNames.length > 0 && declaration.projectShadowPaths) {
    await assertNoProjectConfigShadowsSessionServer({
      cwd: params.cwd,
      relativePaths: declaration.projectShadowPaths,
      serversKey: declaration.serversKey,
      sessionServerNames,
    });
  }

  const source = resolveNativeSessionConfigPaths({
    declaration,
    env: params.env,
    platform,
  });
  const userConfig = await readExistingConfig(source.configPath);
  const configuredUserServers = userConfig[declaration.serversKey];
  const userServers = isRecord(configuredUserServers)
    ? configuredUserServers
    : {};
  const mergedServers = Object.fromEntries([
    ...Object.entries(userServers).map(([name, entry]) => [
      name,
      withSourceConfigRoot(entry, source.configRootEnvKey, source.configRoot),
    ]),
    ...Object.entries(sessionServers).map(([name, config]) => [
      name,
      buildSessionServerEntry({
        config,
        constants: declaration.serverEntryConstants ?? {},
        configRootEnvKey: source.configRootEnvKey,
        sourceConfigRoot: source.configRoot,
      }),
    ]),
  ]);

  const sessionRoot = createSecureTempDirectorySync({
    prefix: `happier-acp-${declaration.directory}`,
  });
  try {
    const sessionDirectoryPath = join(sessionRoot.path, declaration.directory);
    await Promise.all([
      linkDirectoryChildren({
        source: source.directoryPath,
        destination: sessionDirectoryPath,
        exclude: [declaration.fileName, ...(params.skills ? [params.skills.subdirectory] : [])],
      }),
      linkDirectoryChildren({
        source: source.configRoot,
        destination: sessionRoot.path,
        exclude: [declaration.directory],
      }),
    ]);
    await mkdir(sessionDirectoryPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(sessionDirectoryPath, declaration.fileName),
      JSON.stringify({ ...userConfig, [declaration.serversKey]: mergedServers }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    if (params.skills) {
      const destination = join(sessionDirectoryPath, params.skills.subdirectory);
      await linkDirectoryChildren({ source: join(source.directoryPath, params.skills.subdirectory), destination });
      await linkDirectoryChildren({ source: params.skills.delivery.skillsRoot, destination });
    }
    let cleaned = false;
    return Object.freeze({
      env: Object.freeze({ [source.configRootEnvKey]: sessionRoot.path }),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        sessionRoot.cleanup();
      },
    });
  } catch (error) {
    sessionRoot.cleanup();
    throw error;
  }
}
