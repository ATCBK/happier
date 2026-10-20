import { describe, expect, it } from 'vitest';

import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Qwen plugin manifest', () => {
  it('uses the strict target manifest and the shared declarative ACP owner', () => {
    expect(PLUGIN_MANIFEST).not.toHaveProperty('uses');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('permissions');
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activationEvents');
    expect(PLUGIN_MANIFEST).toMatchObject({ entrypoints: { daemon: './.happier-plugin/daemon.js' } });
    expect(PLUGIN_MANIFEST).not.toHaveProperty('activation');
    expect(PLUGIN_MANIFEST).toMatchObject({
      hostAccess: {
        required: [{
          id: 'qwen-native-history',
          capability: 'filesystem',
          scope: { locations: [{ root: 'workspace' }], access: ['read'] },
        }, {
          id: 'qwen-process',
          capability: 'process',
          scope: { executables: [{ kind: 'systemTool', id: 'qwen-cli' }] },
        }],
        optional: [],
      },
      contributes: {
        agents: [{
          id: 'qwen', title: 'Qwen Code', primary: 'sessions',
          runtime: {
            kind: 'acp',
            transport: {
              kind: 'stdio',
              executable: { kind: 'systemTool', id: 'qwen-cli' },
              args: ['--acp'],
            },
            definition: {
              modelConfigOptionId: 'model',
              permissionModeMapping: {
                default: null,
                'read-only': 'plan',
                'safe-yolo': 'auto-edit',
                yolo: 'yolo',
                plan: 'plan',
              },
              permissionModeArgv: {
                flag: '--approval-mode',
                map: {
                  default: null,
                  'read-only': 'plan',
                  'safe-yolo': 'auto-edit',
                  yolo: 'yolo',
                  plan: 'plan',
                },
              },
              mcp: { policy: 'pass_through' },
            },
          },
          capabilities: {
            surfaces: ['externalSessions'],
            sessions: {
              open: ['create', 'resume'],
              delivery: ['newTurn', 'followUp'],
              cancel: true,
              configuration: true,
              executionRunContext: { versions: [1] },
            },
          },
          surfaces: {
            externalSession: {
              sources: [{
                sourceKind: 'qwenRuntimeDir',
                contentSearch: true,
                schema: { fields: [{ kind: 'literal', name: 'kind', value: 'qwenRuntimeDir' },
                  { kind: 'string', name: 'runtimeDir', min: 1, max: 10_000, nullish: true }] },
                key: { segments: [{ kind: 'literal', value: 'qwenRuntimeDir' }, { kind: 'field', field: 'runtimeDir' }] },
                instances: [{ kind: 'default', constants: {} }],
              }],
            },
          },
        }],
        systemTools: [{ id: 'qwen-cli', executableNames: ['qwen'] }],
      },
    });
  });

  it('declares only the native reader registration beside the shared ACP runtime', () => {
    expect(derivePluginDaemonContributionRegistrationRights(
      PLUGIN_MANIFEST.contributes as unknown as Readonly<Record<string, unknown>>,
    )).toMatchObject([{ family: 'agents', localId: 'qwen', target: { realm: 'daemon' }, requiredFields: ['externalSessions'] }]);
  });
});
