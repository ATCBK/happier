import { definePlugin } from '@happier-dev/plugin-sdk';

import { createSessionAgentRuntime } from './agent/sessionAgent.js';

export const { manifest, activate } = definePlugin({
  id: "qa.capabilities",
  version: "0.1.0",
  displayName: "QA capabilities",
  description: "QA capabilities custom Session Agent.",
  entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
  skills: {
    'check-capabilities': { directory: './resources/skills/check-capabilities' },
  },
  mcp: {
    servers: {
      'fixture-tools': {
        declaration: {
          kind: 'dynamic',
          title: 'Capability fixture tools',
          description: 'A deterministic read-only tool for external plugin QA.',
          sessionScope: 'global',
        },
        runtime: {
          async listTools() {
            return { items: [{ name: 'status', description: 'Read the fixture status.', inputSchema: {
              type: 'object', properties: {}, additionalProperties: false,
            } }] };
          },
          async callTool() { return { content: [{ kind: 'json', value: { status: 'ready' } }] }; },
          async listResources() { return { items: [] }; },
          async listResourceTemplates() { return { items: [] }; },
          async readResource() { return { contents: [] }; },
          async subscribeResource() { return { dispose() {} }; },
          async listPrompts() { return { items: [] }; },
          async getPrompt() { return { messages: [] }; },
          dispose() {},
        },
      },
    },
  },
  agents: {
    "session-agent": {
      declaration: {
        title: "QA capabilities",
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: {
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn'],
            cancel: true,
          },
        },
      },
      factory: createSessionAgentRuntime,
      sessionRunnerFactory: {
        module: "./agent/sessionAgent.js",
        export: "createSessionAgentRuntime",
        runtimeApiVersion: 1,
      },
    },
  },
});
