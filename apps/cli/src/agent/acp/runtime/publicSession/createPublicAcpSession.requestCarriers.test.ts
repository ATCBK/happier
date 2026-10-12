import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPublicAcpExecutionRun, createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it.each(['session', 'execution_run'] as const)('delivers request-only MCP bindings to ACP session/new for %s', async (scope) => {
  await withTempDir('happier-acp-request-carriers-', async (dir) => {
    const capture = join(dir, 'new-session.json');
    const script = writeAcpTestAgentScript({ dir, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      import { writeFileSync } from 'node:fs';
      const lines = createInterface({ input: process.stdin });
      for await (const line of lines) {
        const r = JSON.parse(line);
        if (r.id === undefined) continue;
        let result = {};
        if (r.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
        if (r.method === 'session/new') {
          writeFileSync(process.env.CAPTURE, JSON.stringify(r.params));
          result = { sessionId: 'native-session' };
        }
        if (r.method === 'session/prompt') result = { stopReason: 'end_turn' };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
      }
    ` });
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'fixture', agentId: 'fixture', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
        kind: 'binary', executablePath: process.execPath, args: [script], env: { CAPTURE: capture },
      } }) },
      interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    const options: AgentAcpRuntimeOptions = {
      transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
      definition: { mcp: { policy: 'pass_through' } },
    };
    const mcpServers = { guide: { command: 'guide-mcp', args: ['serve'], env: { GUIDE: 'yes' } } };
    const runtime = scope === 'session'
      ? await createPublicAcpSession({ kind: 'create', sessionId: 'session', cwd: dir, mcpServers }, options, dependencies)
      : await createPublicAcpExecutionRun({ kind: 'create', runId: 'run', cwd: dir, mcpServers,
          profile: { pluginId: 'fixture', localId: 'default' }, input: { text: 'Use guide' } }, options, dependencies);
    try {
      expect(JSON.parse(readFileSync(capture, 'utf8'))).toMatchObject({
        mcpServers: [{ name: 'guide', command: 'guide-mcp', args: ['serve'], env: [{ name: 'GUIDE', value: 'yes' }] }],
      });
    } finally {
      await runtime.dispose();
    }
  });
});
