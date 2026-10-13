import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { PluginAgentAcpSkillsSessionDeliveryV2 } from '@happier-dev/protocol';
import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { createSecureTempDirectorySync, expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import type { NativeSessionConfigDelivery } from './nativeSessionConfig';

type JsonObject = Record<string, unknown>;
function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unionAtPath(root: JsonObject, path: readonly string[], values: readonly string[]): JsonObject {
  const key = path[0]!;
  const previous = Object.hasOwn(root, key) ? root[key] : undefined;
  if (path.length === 1) {
    if (previous !== undefined && (!Array.isArray(previous) || !previous.every((value: unknown) => typeof value === 'string'))) {
      throw new Error('The native skill defaults list must contain strings.');
    }
    return { ...root, [key]: [...new Set([...(previous ?? []), ...values])] };
  }
  if (previous !== undefined && !isRecord(previous)) throw new Error('The native skill defaults path must contain objects.');
  return { ...root, [key]: unionAtPath(previous ?? {}, path.slice(1), values) };
}

/** Applies the declared extra-root or defaults-file knob without mutating native configuration. */
export async function prepareAcpSessionSkills(params: Readonly<{
  declaration: Exclude<PluginAgentAcpSkillsSessionDeliveryV2, { kind: 'native_config_skills_dir' }>;
  skills: AgentSessionSkillDelivery;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}>): Promise<NativeSessionConfigDelivery> {
  const declaration = params.declaration;
  if (declaration.kind === 'env_path_list') {
    const inherited = Object.hasOwn(params.env, declaration.envKey) ? params.env[declaration.envKey] : undefined;
    const root = declaration.value === 'plugin_root' ? params.skills.pluginRoot : params.skills.skillsRoot;
    const separator = declaration.separator === ',' ? ',' : delimiter;
    return { env: { [declaration.envKey]: inherited ? `${inherited}${separator}${root}` : root }, cleanup() {} };
  }
  let defaults: JsonObject = {};
  const inheritedFile = Object.hasOwn(params.env, declaration.envKey) ? params.env[declaration.envKey] : undefined;
  if (inheritedFile) {
    const home = resolveHomeDirFromEnvironment(params.env, process.platform);
    const file = resolve(params.cwd, expandHomePath(inheritedFile, home, process.platform));
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error('The native skill defaults file must contain an object.');
    defaults = parsed;
  }
  defaults = unionAtPath(defaults, declaration.directoriesKeyPath, [params.skills.skillsRoot]);
  if (declaration.disabledKeyPath) {
    defaults = unionAtPath(defaults, declaration.disabledKeyPath, params.skills.nativeDisables.map(item => item.name));
  }
  const directory = createSecureTempDirectorySync({ prefix: 'happier-acp-skill-defaults' });
  try {
    const file = join(directory.path, 'defaults.json');
    await writeFile(file, JSON.stringify(defaults), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { env: { [declaration.envKey]: file }, cleanup: directory.cleanup };
  } catch (error) {
    directory.cleanup();
    throw error;
  }
}
