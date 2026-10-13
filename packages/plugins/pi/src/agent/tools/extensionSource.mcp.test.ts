import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPiHappierToolsExtensionSource } from './extensionSource.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

type Tool = Readonly<{
  name: string;
  execute(callId: string, args: unknown, signal: AbortSignal | undefined, update: undefined,
    ctx: { cwd: string; ui: { confirm(title: string, message: string): Promise<boolean> } }): Promise<unknown>;
}>;

// A real child process is the MCP system boundary; extension logic is unmocked.
const serverSource = `
import { createInterface } from 'node:readline';
let calls = 0;
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (message.method === 'tools/list') result = message.params.cursor
    ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
    : { tools: [{ name: 'toString', inputSchema: { type: 'object' } }], nextCursor: 'second' };
  else if (message.method === 'tools/call') {
    calls++;
    result = message.params.arguments.text === 'fail'
      ? { isError: true, content: [{ type: 'text', text: 'fixture tool failed' }] }
      : { content: [{ type: 'text', text: process.env.MCP_FIXTURE_PREFIX + message.params.arguments.text }], structuredContent: { calls } };
  }
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
lines.on('close', () => process.exit(0));
`;

describe('Pi extension user MCP', () => {
  it.each([
    { enabledTools: ['echo'], mcpToolPolicy: undefined },
    { enabledTools: undefined, mcpToolPolicy: { fixture: { unlisted: 'ask', tools: { toString: 'off', echo: 'allow' } } } },
    { enabledTools: undefined, mcpToolPolicy: { fixture: { unlisted: 'deny', tools: { echo: 'ask' } } } },
  ] satisfies readonly Readonly<{
    enabledTools: string[] | undefined;
    mcpToolPolicy: AgentSessionOpenRequest['mcpToolPolicy'];
  }>[])('filters unavailable tools, keeps confirmation for Allow, and closes the real stdio server ($mcpToolPolicy)', async ({ enabledTools, mcpToolPolicy }) => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-user-mcp-'));
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const tools: Tool[] = [];
    try {
      const extensionPath = join(root, 'extension.mjs');
      const serverPath = join(root, 'server.mjs');
      const configPath = join(root, 'config.json');
      writeFileSync(extensionPath, buildPiHappierToolsExtensionSource());
      writeFileSync(serverPath, serverSource);
      writeFileSync(configPath, JSON.stringify({
        v: 1, sessionId: 'session', directory: root, systemPrompt: '', tools: [],
        launch: { executablePath: process.execPath, argsPrefix: [] },
        mcpServers: { fixture: { command: process.execPath, args: [serverPath], env: { MCP_FIXTURE_PREFIX: 'user:' }, enabledTools } },
        mcpToolPolicy,
      }));
      const module = await import(pathToFileURL(extensionPath).href);
      let activeTools = ['read'];
      module.default({
        registerFlag() {}, getFlag: () => configPath,
        registerTool(tool: Tool) { tools.push(tool); },
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = names; },
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
      });
      for (const handler of handlers.get('session_start') ?? []) await handler({});
      expect(tools.map(tool => tool.name)).toEqual(['mcp__fixture__echo']);
      expect(activeTools).toEqual(['read', 'mcp__fixture__echo']);
      const tool = tools[0]!;
      await expect(tool.execute('denied', { text: 'denied' }, undefined, undefined,
        { cwd: root, ui: { confirm: async () => false } })).rejects.toThrow(/denied/i);
      const prompts: string[] = [];
      const result = await tool.execute('allowed', { text: 'hello' }, undefined, undefined,
        { cwd: root, ui: { confirm: async title => { prompts.push(title); return true; } } });
      expect(prompts).toHaveLength(1);
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'user:hello' }], details: { structuredContent: { calls: 1 } } });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(tool.execute('cancelled', {}, cancelled.signal, undefined,
        { cwd: root, ui: { confirm: async () => { throw new Error('must not ask after cancellation'); } } }))
        .rejects.toThrow(/cancelled/i);
      await expect(tool.execute('failed', { text: 'fail' }, undefined, undefined,
        { cwd: root, ui: { confirm: async () => true } })).rejects.toThrow('fixture tool failed');
    } finally {
      for (const handler of handlers.get('session_shutdown') ?? []) await handler({});
      rmSync(root, { recursive: true, force: true });
    }
  });
});
