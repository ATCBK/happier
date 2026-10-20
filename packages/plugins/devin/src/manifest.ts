import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { detectDevinCliAuthStatus } from './agent/auth/status.js';
import { DEVIN_ACP_RUNTIME_DECLARATION } from './agent/acp/runtimeDeclaration.js';
import { AGENT_DEFINITION } from './agent/definition.js';
import { DEVIN_TERMINAL_SURFACE } from './agent/terminal/contribution.js';
import { DEVIN_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import { DEVIN_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

const {
  id: DEVIN_AGENT_SETTINGS_CONTRIBUTION_ID,
  ...DEVIN_AGENT_SETTINGS_DECLARATION
} = DEVIN_AGENT_SETTINGS_CONTRIBUTION;

export const DEVIN_PLUGIN = definePlugin({
  id: 'happier.agent.devin',
  version: '0.0.0',
  displayName: 'Devin',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'devin-process',
      capability: 'process',
      reason: 'Run the declared Devin CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'devin-cli' }],
        envKeys: ['XDG_CONFIG_HOME', 'APPDATA'],
      },
    }],
    optional: [],
  },
  agents: {
    devin: {
      declaration: {
        title: { key: 'agentInput.agent.devin', fallback: 'Devin' },
        description: {
          key: 'profiles.aiBackend.devinSubtitleExperimental',
          fallback: 'Devin CLI (experimental)',
        },
        runtime: DEVIN_ACP_RUNTIME_DECLARATION,
        cli: {
          displayName: 'Devin CLI',
          executable: {
            binaryName: 'devin',
            knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreference: 'system-first',
            systemCommandResolutionStrategy: 'path-first',
          },
          install: {
            managed: null,
            manual: { kind: 'command' },
            guideUrl: 'https://docs.devin.ai/work-with-devin/devin-cli',
            docsUrl: 'https://docs.devin.ai/work-with-devin/devin-cli',
          },
          auth: {
            support: 'login_terminal',
            nonInteractiveStatusProbe: true,
            loginLaunches: [{ kind: 'primary', args: ['auth', 'login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          acpRegistryIds: [...AGENT_DEFINITION.acpRegistryIds],
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported',
            nativeRoots: { user: [['.config', 'devin', 'skills'], ['.config', 'cognition', 'skills'], ['.agents', 'skills']], project: [['.devin', 'skills'], ['.cognition', 'skills'], ['.agents', 'skills'], ['.windsurf', 'skills']] } },
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
          },
        }),
      },
      cliAuth: {
        detectAuthStatus: async ({ runDeclaredSystemToolCommand }) =>
          await detectDevinCliAuthStatus({
            runCommand: async (args, options) => await runDeclaredSystemToolCommand({
              toolId: 'devin-cli',
              args,
              ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            }),
          }),
      },
      terminal: DEVIN_TERMINAL_SURFACE,
    },
  },
  systemTools: {
    'devin-cli': { title: 'Devin CLI', executableNames: ['devin'] },
  },
  settings: {
    [DEVIN_AGENT_SETTINGS_CONTRIBUTION_ID]: DEVIN_AGENT_SETTINGS_DECLARATION,
  },
  ui: {
    translations: DEVIN_UI_TRANSLATION_BUNDLES,
  },
});

export const PLUGIN_MANIFEST = DEVIN_PLUGIN.manifest;
