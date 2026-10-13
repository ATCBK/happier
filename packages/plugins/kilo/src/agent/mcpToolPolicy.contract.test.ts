import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { runAgentMcpToolPolicyContract } from '../../../../plugin-sdk/src/testing/mcpToolPolicyContract.js';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { createKiloAgentRuntime } from './runtime/factory.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { describe } from 'vitest';

const parsed = parsePluginManifest(PLUGIN_MANIFEST);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === 'kilo');
if (!agent) throw new Error('Missing authored Kilo Agent');
describe('Kilo mode-generated permission environment', () => runAgentMcpToolPolicyContract(createAcpMcpPolicyFixture({
  agent, pluginId: parsed.manifest.id, factory: createKiloAgentRuntime, toolWireFormat: 'underscore',
})));

// Caller-owned native permission environments are an existing product path.
// This characterization does not stand in for the mode-generated launch above.
describe('Kilo caller-owned permission environment', () => runAgentMcpToolPolicyContract(createAcpMcpPolicyFixture({
  agent, pluginId: parsed.manifest.id, toolWireFormat: 'underscore',
  async factory(context) {
    const runtime = await createKiloAgentRuntime(context);
    return { ...runtime, sessions: { ...runtime.sessions,
      open(request, host) {
        return runtime.sessions.open({ ...request, launchEnvironment: {
          values: { ...request.launchEnvironment?.values, KILO_PERMISSION: '{"*":"ask"}' },
          unset: (request.launchEnvironment?.unset ?? []).filter(key => key !== 'KILO_PERMISSION'),
        } }, host);
      },
    } };
  },
})));
