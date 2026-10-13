import { runAgentMcpToolPolicyContract } from '../../../../plugin-sdk/src/testing/mcpToolPolicyContract.js';
import { createOpenCodeMcpToolPolicyFixture } from './runtime/server/mcpToolPolicy.test-support.js';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createOpenCodeAgentRuntime } from './runtime/nativeRuntime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { describe } from 'vitest';
import { createLocalModelVendorBoundary } from '@/agent/acp/testkit/mcpToolPolicyVendorBoundary';

describe('OpenCode managed V1', () => runAgentMcpToolPolicyContract(createOpenCodeMcpToolPolicyFixture()));
if (process.env.HAPPIER_MCP_VENDOR_EXECUTABLE) describe('installed OpenCode managed V1', () => runAgentMcpToolPolicyContract(
  createOpenCodeMcpToolPolicyFixture(message => console.log(message), createLocalModelVendorBoundary(process.env.HAPPIER_MCP_VENDOR_EXECUTABLE!, 'openai')),
));

const parsed = parsePluginManifest(PLUGIN_MANIFEST);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === 'opencode');
if (!agent) throw new Error('Missing authored OpenCode Agent');
describe('OpenCode ACP', () => runAgentMcpToolPolicyContract(createAcpMcpPolicyFixture({
  agent, pluginId: parsed.manifest.id, toolWireFormat: 'underscore',
  async factory(context) {
    const runtime = await createOpenCodeAgentRuntime(context);
    return { ...runtime, sessions: { ...runtime.sessions,
      open(request, host) {
        return runtime.sessions.open({ ...request, configuration: { ...request.configuration!, options: {
          ...request.configuration?.options, opencodeBackendMode: { value: 'acp', updatedAtMs: 0 },
        } } }, { ...host, services: { ...host.services, connectedAccounts: {
          ...host.services.connectedAccounts,
          watch(_purpose, listener) { listener({ kind: 'resync' }); return { dispose() {} }; },
          getBinding: async () => null,
        } } });
      },
    } };
  },
})));
