import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { createCopilotAgentRuntime } from './agent/runtime/factory.js';
import { COPILOT_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { COPILOT_UI_TRANSLATION_BUNDLES } from './ui/translations.js';
import { COPILOT_PREFLIGHT_SESSION_CONTROLS } from './agent/acp/preflight.js';
import { copilotExternalSessionsContribution } from './agent/externalSessions/contribution.js';

const COPILOT_AUTH_ENV_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

const {
  id: COPILOT_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...COPILOT_AGENT_SETTINGS_DECLARATION
} = COPILOT_AGENT_SETTINGS_CONTRIBUTION;

export const COPILOT_PLUGIN = definePlugin({
  id: 'happier.agent.copilot',
  version: '0.0.0',
  displayName: 'GitHub Copilot',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'copilot-process',
      capability: 'process',
      reason: 'Run the declared GitHub Copilot CLI executable.',
      scope: {
        executables: [
          { kind: 'systemTool', id: 'copilot-cli' },
        ],
        envKeys: [...COPILOT_AUTH_ENV_KEYS],
      },
    }],
    optional: [],
  },
  agents: {
    copilot: {
      declaration: {
        title: 'GitHub Copilot',
        runtime: { kind: 'custom' },
        cli: {
          displayName: 'GitHub Copilot CLI',
          executable: {
            binaryName: 'copilot',
            knownUserBinDirSuffixes: null,
            sourcePreference: 'system-first',
          },
          install: {
            managed: {
              kind: 'managed_package',
              packageName: '@github/copilot',
              binaryName: 'copilot',
            },
            manual: { kind: 'command' },
            guideUrl: null,
            docsUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli',
          },
          auth: {
            support: 'login_terminal',
            environmentVariables: [...COPILOT_AUTH_ENV_KEYS],
            credentialPaths: ['~/.copilot/config.json'],
            missingCredentialState: 'unknown',
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.copilot', 'skills'], ['.agents', 'skills']], project: [['.github', 'skills'], ['.agents', 'skills'], ['.claude', 'skills']] } },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            executionRunContext: { versions: [1] },
          },
        }),
        surfaces: { externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{ sourceKind: 'copilotHome', contentSearch: true,
            schema: { fields: [
              { kind: 'literal', name: 'kind', value: 'copilotHome' },
              { kind: 'string', name: 'homeDir', min: 1, max: 10_000, nullish: true },
            ] },
            key: { segments: [{ kind: 'literal', value: 'copilotHome' }, { kind: 'field', field: 'homeDir' }] },
            instances: [{ kind: 'default', constants: {} }],
          }],
        } },
      },
      factory: createCopilotAgentRuntime,
      externalSessions: copilotExternalSessionsContribution,
      preflightSessionControls: COPILOT_PREFLIGHT_SESSION_CONTROLS,
      sessionRunnerFactory: {
        module: './agent/runtime/factory',
        export: 'createCopilotAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'copilotExternalSessionsContribution',
      },
    },
  },
  systemTools: {
    'copilot-cli': {
      title: 'GitHub Copilot CLI',
      executableNames: ['copilot'],
    },
  },
  ui: {
    translations: COPILOT_UI_TRANSLATION_BUNDLES,
  },
  settings: {
    [COPILOT_AGENT_SETTINGS_CONTRIBUTION_ID]: COPILOT_AGENT_SETTINGS_DECLARATION,
  },
});

export const PLUGIN_MANIFEST = COPILOT_PLUGIN.manifest;
