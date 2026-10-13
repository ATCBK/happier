import { describe, it } from 'vitest';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { runAgentMcpToolPolicyContract } from '@happier-dev/plugin-sdk/testing';
import { createAcpMcpPolicyFixture, createDeclarativeAcpMcpPolicyFixtures, createGeminiMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { createLocalModelVendorBoundary } from '@/agent/acp/testkit/mcpToolPolicyVendorBoundary';
import { createOpenCodeAgentRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/nativeRuntime';
import { PLUGIN_MANIFEST as openCodeManifest } from '../../../../../../../packages/plugins/opencode/src/manifest';
import { createKiloAgentRuntime } from '../../../../../../../packages/plugins/kilo/src/agent/runtime/factory';
import { PLUGIN_MANIFEST as kiloManifest } from '../../../../../../../packages/plugins/kilo/src/manifest';

// An explicit isolated executable is required. Ordinary source tests never claim vendor evidence.
const selected = process.env.HAPPIER_MCP_VENDOR_AGENT;
const executablePath = process.env.HAPPIER_MCP_VENDOR_EXECUTABLE;
const declarative = selected === 'qwen' && executablePath ? await createDeclarativeAcpMcpPolicyFixtures(agent => agent.id === selected
  ? createLocalModelVendorBoundary(executablePath, 'openai') : undefined) : [];
if (selected && executablePath) describe('installed ACP vendor MCP policy admission', () => {
  if (selected === 'gemini') {
    runAgentMcpToolPolicyContract(createGeminiMcpPolicyFixture(createLocalModelVendorBoundary(executablePath!, 'google')));
    return;
  }
  if (selected === 'qwen') {
    const fixture = declarative.find(input => input.agent.id === selected);
    if (!fixture) throw new Error('Missing authored Qwen fixture');
    runAgentMcpToolPolicyContract(fixture); return;
  }
  const manifest = selected === 'kilo' ? kiloManifest : openCodeManifest;
  const parsed = parsePluginManifest(manifest);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === selected);
  if (!agent) throw new Error(`Unsupported installed vendor fixture: ${selected}`);
  runAgentMcpToolPolicyContract(createAcpMcpPolicyFixture({ agent, pluginId: parsed.manifest.id,
    toolWireFormat: 'underscore', vendor: createLocalModelVendorBoundary(executablePath!, 'openai'),
    factory: selected === 'kilo' ? createKiloAgentRuntime : async context => {
      const runtime = await createOpenCodeAgentRuntime(context);
      return { ...runtime, sessions: { ...runtime.sessions,
        open(request, host) {
          return runtime.sessions.open({ ...request, configuration: { ...request.configuration!, options: {
            ...request.configuration?.options, opencodeBackendMode: { value: 'acp', updatedAtMs: 0 },
          } } }, host);
        },
      } };
    },
  }));
});
else it.skip('requires an explicitly selected isolated installed ACP vendor executable', () => {});
