import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { KILO_ACP_COMMAND } from './agent/acp/command.js';
import { KILO_PERMISSION_ENV } from './agent/permissions/kiloPermissionPolicy.js';
import { createKiloAgentRuntime } from './agent/runtime/factory.js';
import { KILO_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { kiloExternalSessionsContribution } from './agent/externalSessions/contribution.js';

const {
  id: KILO_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...KILO_AGENT_SETTINGS_DECLARATION
} = KILO_AGENT_SETTINGS_CONTRIBUTION;

export const KILO_PLUGIN = definePlugin({
  id: 'happier.agent.kilo',
  version: '0.0.0',
  displayName: 'Kilo',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'kilo-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the Kilo process working directory.',
      scope: { locations: [{ root: 'workspace' }], access: ['read'] },
    }, {
      id: 'kilo-process',
      capability: 'process',
      reason: 'Run the declared Kilo CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'kilo-cli' }],
        envKeys: [KILO_PERMISSION_ENV],
      },
    }],
    optional: [],
  },
  agents: {
    kilo: {
      declaration: {
        title: 'Kilo',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'Kilo CLI',
          executable: {
            binaryName: 'kilo',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@kilocode/cli',
              binaryName: 'kilo',
            },
            manual: { kind: 'command' },
            guideUrl: null,
            docsUrl: 'https://kilo.ai/docs/cli',
          },
          auth: {
            support: 'login_terminal',
            loginLaunches: [{ kind: 'primary', args: [], initialInput: '/connect\r' }],
          },
        },
        primary: 'sessions',
        catalog: {
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: {
            delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: {
              user: [['.agents', 'skills'], ['.claude', 'skills'], ['.kilo', 'skills']],
              project: [['.agents', 'skills'], ['.claude', 'skills'], ['.kilo', 'skills'], ['.kilocode', 'skills']],
            },
          },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: {
          externalSession: {
            externalLinkedTakeover: { writerSafety: 'unsupported' },
            sources: [{ sourceKind: 'kiloStorage', contentSearch: true,
              schema: { fields: [
                { kind: 'literal', name: 'kind', value: 'kiloStorage' },
                { kind: 'string', name: 'storageRoot', min: 1, nullish: true },
              ] },
              key: { segments: [{ kind: 'literal', value: 'kiloStorage' }, { kind: 'field', field: 'storageRoot' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
      },
      factory: createKiloAgentRuntime,
      preflightSessionControls: {
        catalogs: { kind: 'acp', command: KILO_ACP_COMMAND },
        models: {
          command: {
            toolId: 'kilo-cli',
            args: ['models'],
          },
        },
      },
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createKiloAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'kiloExternalSessionsContribution',
      },
      externalSessions: kiloExternalSessionsContribution,
    },
  },
  systemTools: {
    'kilo-cli': { title: 'Kilo CLI', executableNames: ['kilo'] },
  },
  settings: {
    [KILO_AGENT_SETTINGS_CONTRIBUTION_ID]: KILO_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = KILO_PLUGIN.manifest;
