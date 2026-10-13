import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeMcpStdioServerTools } from './probeMcpStdioServerTools';

// A real child process owns the external MCP boundary; no internal probe logic is mocked.
const fixture = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], String(process.pid));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'probe-fixture', version: '1.0.0' }, instructions: 'Use the read tool first.'
  };
  else if (request.method === 'tools/list') {
    if (process.argv[2] === 'hang') { fs.writeFileSync(process.argv[1] + '.listing', 'ready'); return; }
    result = request.params?.cursor === 'second'
      ? { tools: [{ name: 'later_page', annotations: { title: 'Older display title' }, inputSchema: { type: 'object' } }] }
      : { tools: [{ name: 'first_page', title: 'Read records', description: 'Lists records.',
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          inputSchema: { type: 'object' } }], nextCursor: 'second' };
  } else return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
`;

describe('probeMcpStdioServerTools', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function fixtureConfig(mode = 'pages') {
    const directory = await mkdtemp(join(tmpdir(), 'happier-mcp-probe-'));
    directories.push(directory);
    const marker = join(directory, 'started');
    return { marker, config: { command: process.execPath, args: ['-e', fixture, marker, mode] } };
  }

  it('includes tools from every native listTools page', async () => {
    const { config } = await fixtureConfig();
    await expect(probeMcpStdioServerTools({ config })).resolves.toMatchObject({
      serverInfo: { name: 'probe-fixture', version: '1.0.0' }, protocolVersion: expect.any(String),
      instructions: 'Use the read tool first.', tools: [
        { name: 'first_page', title: 'Read records', description: 'Lists records.',
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          inputSchema: { type: 'object' } },
        { name: 'later_page', title: 'Older display title', inputSchema: { type: 'object' } },
      ],
    });
  });

  it('does not launch a stdio server for an already aborted request', async () => {
    const { config, marker } = await fixtureConfig();
    const controller = new AbortController();
    controller.abort(new Error('probe-cancelled'));
    await expect(probeMcpStdioServerTools({ config, signal: controller.signal })).rejects.toThrow('probe-cancelled');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts a pending tools request and closes its stdio child', async () => {
    const { config, marker } = await fixtureConfig('hang');
    const controller = new AbortController();
    const probe = probeMcpStdioServerTools({ config, signal: controller.signal, listToolsTimeoutMs: 0 });
    // Attach the rejection assertion before cancellation so no rejection is left unobserved.
    const rejected = expect(probe).rejects.toBeDefined();
    await vi.waitFor(async () => expect(await readFile(`${marker}.listing`, 'utf8')).toBe('ready'));
    const pid = Number(await readFile(marker, 'utf8'));
    controller.abort(new Error('probe-cancelled'));
    await rejected;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
});
