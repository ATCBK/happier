import { createSecureTempDirectorySync, linkDirectoryChildren } from '@happier-dev/plugin-sdk/fs';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveGeminiConfigPaths } from '../utils/configPaths.js';
import type { AgentSessionConfigurationSnapshot, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';

type EnvLike = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;

const GEMINI_ALLOWED_SOURCE_FILE_SELECTORS = [
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userConfigPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.xdgConfigPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userSettingsPath,
] as const;

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function stripJsonComments(input: string): string {
  let result = '';
  let inString = false;
  let escaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? '';
    const next = input[index + 1] ?? '';

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inString && current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (!inString && current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;

    if (!inString && current === '"') {
      inString = true;
      escaping = false;
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (current === '\\') {
        escaping = true;
      } else if (current === '"') {
        inString = false;
      }
    }
  }

  return result;
}

function readJsonObjectWithComments(path: string): { ok: boolean; value: JsonObject } {
  if (!existsSync(path)) return { ok: true, value: {} };

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    return {
      ok: true,
      value: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {},
    };
  } catch (error) {
    return { ok: false, value: {} };
  }
}

function copyKnownGeminiConfigFiles(params: {
  sourceEnv: EnvLike;
  targetEnv: EnvLike;
}): void {
  const sourcePaths = resolveGeminiConfigPaths(params.sourceEnv);
  const targetPaths = resolveGeminiConfigPaths(params.targetEnv);

  for (const selectPath of GEMINI_ALLOWED_SOURCE_FILE_SELECTORS) {
    const sourcePath = selectPath(sourcePaths);
    if (!existsSync(sourcePath)) continue;
    const targetPath = selectPath(targetPaths);
    ensureParentDir(targetPath);
    copyFileSync(sourcePath, targetPath);
  }
}

function scrubCopiedGeminiSettingsMcpServers(targetEnv: EnvLike): void {
  const targetPaths = resolveGeminiConfigPaths(targetEnv);
  if (!existsSync(targetPaths.userSettingsPath)) return;

  const readResult = readJsonObjectWithComments(targetPaths.userSettingsPath);
  if (!readResult.ok) {
    writeFileSync(targetPaths.userSettingsPath, JSON.stringify({}, null, 2), 'utf8');
    return;
  }

  const existingSettings = readResult.value;
  if (!Object.prototype.hasOwnProperty.call(existingSettings, 'mcpServers')) return;

  const nextSettings = { ...existingSettings };
  delete nextSettings.mcpServers;
  writeFileSync(targetPaths.userSettingsPath, JSON.stringify(nextSettings, null, 2), 'utf8');
}

/** Native sessions own this temporary home for exactly their composer lifetime. */
export async function prepareGeminiNativeMcpShaping(
  sourceEnv: EnvLike = process.env,
  configuration?: Pick<AgentSessionConfigurationSnapshot, 'allowedTools' | 'unlistedTools'>,
  skills?: AgentSessionSkillDelivery,
) {
  const tempDirectory = createSecureTempDirectorySync({ prefix: 'happier-gemini-mcp-home' });
  const cliHomeDir = tempDirectory.path;
  const baseEnv = {
    GEMINI_CLI_HOME: cliHomeDir,
    HOME: cliHomeDir,
    XDG_CONFIG_HOME: join(cliHomeDir, '.config'),
  };
  const noTools = configuration?.unlistedTools === 'deny' && configuration.allowedTools?.length === 0;
  const toolSettingsPath = join(cliHomeDir, 'no-tools-settings.json');

  try {
    copyKnownGeminiConfigFiles({ sourceEnv, targetEnv: baseEnv });
    scrubCopiedGeminiSettingsMcpServers(baseEnv);
    if (noTools) {
      // Gemini's system settings override workspace/user settings. An empty
      // core allowlist removes built-ins; admin controls also stop ambient MCP
      // and extension discovery rather than denying a later model tool call.
      writeFileSync(toolSettingsPath, JSON.stringify({
        tools: { core: [] },
        admin: { mcp: { enabled: false }, extensions: { enabled: false } },
      }), 'utf8');
    }
    const sourceHome = resolveGeminiConfigPaths(sourceEnv).cliHomeDir;
    await Promise.all([
      ['.gemini', 'skills'],
      ['.agents', 'skills'],
      ['.gemini', 'extensions'],
    ].map((segments) => linkDirectoryChildren({
      source: join(sourceHome, ...segments),
      destination: join(cliHomeDir, ...segments),
    })));
    if (skills) {
      const destination = join(cliHomeDir, '.agents', 'skills');
      for (const item of skills.items) {
        if (!statSync(join(skills.skillsRoot, item.name, 'SKILL.md')).isFile()) {
          throw new Error('Gemini session skill is unavailable');
        }
        if (process.platform === 'win32' && !existsSync(join(destination, item.name))) {
          cpSync(join(skills.skillsRoot, item.name), join(destination, item.name), { recursive: true });
        }
      }
      if (process.platform !== 'win32') {
        await linkDirectoryChildren({ source: skills.skillsRoot, destination });
      }
      if (skills.nativeDisables.length > 0) {
        const settingsPath = resolveGeminiConfigPaths(baseEnv).userSettingsPath;
        const settings = readJsonObjectWithComments(settingsPath).value;
        const existing = settings.skills;
        const skillSettings = existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing as JsonObject : {};
        const disabled = Array.isArray(skillSettings.disabled)
          ? skillSettings.disabled.filter((name): name is string => typeof name === 'string') : [];
        ensureParentDir(settingsPath);
        writeFileSync(settingsPath, JSON.stringify({ ...settings, skills: { ...skillSettings,
          disabled: [...new Set([...disabled, ...skills.nativeDisables.map(item => item.name)].map(name => name.toLowerCase()))],
        } }), 'utf8');
      }
    }
  } catch (error) {
    tempDirectory.cleanup();
    throw error;
  }

  let cleaned = false;
  return {
    env: { ...baseEnv, ...(noTools ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: toolSettingsPath } : {}) },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      tempDirectory.cleanup();
    },
  };
}
