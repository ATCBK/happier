import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildOpenCodeManagedServerSpawnSpec } from './spawnSpec.js';
import { mergeOpenCodeConfigContent, readOpenCodeConfigPart } from './opencodeConfigContent.js';
import { readOpenCodeProviderConfigPart } from '../../providerBinding/runtime.js';
import { OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH } from '../../providerBinding/adapter.js';
import { buildOpenCodeV2ConnectedAuthConfigPart, resolveOpenCodeRequestAuthV2PluginDir } from '../../auth/services/requestAuth/assets.js';

describe('OpenCode config composition', () => {
  it('keeps later native permission overlays last even when ambient keys were already present', () => {
    const config = JSON.parse(mergeOpenCodeConfigContent([
      { permission: { docs_delete: 'allow', 'docs_*': 'allow', unrelated: 'ask' } },
      { permission: { 'docs_*': 'ask', docs_delete: 'deny' } },
    ]));
    expect(Object.keys(config.permission)).toEqual(['unrelated', 'docs_*', 'docs_delete']);
  });
  it('preserves provider-binding settings and connected auth in the spawned child', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-config-'));
    try {
      const configPath = join(rootPath, OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH);
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        providers: { openai: { settings: { baseURL: 'https://model.example/v1' } } },
        plugins: ['provider-plugin'],
      }));
      const providerPart = await readOpenCodeProviderConfigPart({
        kind: 'create', sessionId: 'session-config', cwd: rootPath,
        providerBinding: {
          connectionId: ProviderConnectionIdSchema.parse('pc_model_work'),
          model: { id: 'work-model', name: 'Work model' },
          materialization: {
            v: 1, kind: 'configFile', rootPath,
            relativePaths: [OPENCODE_PROVIDER_CONFIG_RELATIVE_PATH],
          },
        },
      });
      if (providerPart === undefined) throw new Error('Expected provider config');
      const authPart = buildOpenCodeV2ConnectedAuthConfigPart({
        configHome: rootPath,
        directApiKeys: { openai: 'selected-key' },
        requestAuthProviders: ['anthropic'],
      });
      const spec = buildOpenCodeManagedServerSpawnSpec({
        id: 'opencode-server', dialect: 'v2', systemToolId: 'opencode2',
        configParts: [providerPart, authPart],
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ['/user'] } }) },
        additionalEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: ['/session'] } }) },
      });
      if (spec.mode.kind !== 'spawn') throw new Error('Expected managed spawn');
      expect(JSON.parse(spec.mode.launch.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
        providers: {
          anthropic: {},
          openai: { settings: { baseURL: 'https://model.example/v1', apiKey: 'selected-key' } },
        },
        plugins: ['provider-plugin', resolveOpenCodeRequestAuthV2PluginDir(rootPath, 'anthropic')],
        skills: { paths: ['/user', '/session'] },
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('merges nested policy and skills lists without mutating parts', () => {
    const parts = [
      { permission: { skill: { '*': 'ask' } }, skills: { paths: ['/user'] } },
      { permission: { skill: { review: 'allow' } }, skills: { paths: ['/session'] } },
    ];
    const original = JSON.stringify(parts);
    expect(JSON.parse(mergeOpenCodeConfigContent(parts))).toEqual({
      permission: { skill: { '*': 'ask', review: 'allow' } },
      skills: { paths: ['/user', '/session'] },
    });
    expect(JSON.stringify(parts)).toBe(original);
    expect(mergeOpenCodeConfigContent([])).toBe('{}');
    expect(() => readOpenCodeConfigPart('[]')).toThrow();
  });
});
