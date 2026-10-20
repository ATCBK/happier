import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpServersSettingsV1Schema, resolveSessionCapabilitiesV1, projectMcpServerMaterializationV1 } from '@happier-dev/protocol';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

import { McpServerProbeError, probeMcpStdioServerTools } from './probeMcpStdioServerTools';
import { materializeMcpServerConfigRecord } from './materializeMcpServerConfigRecord';
import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { mapMcpRegistryServerV1 } from '@happier-dev/protocol/mcp/servers/registry/mapMcpRegistryServerV1';
import { McpRegistryServerV1Schema } from '@happier-dev/protocol/registries';

const releaseNetwork = vi.hoisted(() => ({ origin: '' }));

// Redirect the external GitHub HTTPS boundary to a real fixture HTTP server;
// release selection, verified download, installation and MCP launch stay real.
vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request: (url: string | URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (!releaseNetwork.origin) throw new Error('Unexpected external HTTPS request');
    const requested = new URL(String(url));
    if (requested.hostname !== 'api.github.com' || requested.pathname !== '/repos/pnpm/pnpm/releases/latest') {
      throw new Error(`Unexpected release request: ${requested.origin}${requested.pathname}`);
    }
    return httpRequest(`${releaseNetwork.origin}/release`, options, callback);
  },
}));

afterEach(() => { releaseNetwork.origin = ''; });

const require = createRequire(import.meta.url);

async function probeFixture(params: Parameters<typeof probeMcpStdioServerTools>[0]) {
  try {
    return await probeMcpStdioServerTools(params);
  } catch (error) {
    if (error instanceof McpServerProbeError && error.stderrTail) {
      throw new Error(`${error.message}\n${error.stderrTail}`, { cause: error });
    }
    throw error;
  }
}

function buildFixtureServerScript(): string {
  const mcpServerUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
  const stdioTransportUrl = pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
  const zodUrl = pathToFileURL(require.resolve('zod/mini')).href;

  return `
import { McpServer } from ${JSON.stringify(mcpServerUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioTransportUrl)};
import { z } from ${JSON.stringify(zodUrl)};

const server = new McpServer({ name: 'fixture-mcp', version: '1.0.0' });
server.registerTool('fixture_tool', { inputSchema: z.optional(z.object({})) }, async () => ({ content: [{ type: 'text', text: process.cwd() }] }));

const transport = new StdioServerTransport();
await server.connect(transport);
`;
}

function buildFakePnpmScript(): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';

const goodCwd = process.env.GOOD_CWD ?? '';
const fixtureServer = process.env.FIXTURE_MCP_SERVER ?? '';
const args = process.argv.slice(2);

if (!goodCwd || !fixtureServer || process.cwd() !== goodCwd || args[0] !== 'dlx') {
  throw new Error('Fixture package runner received an invalid cwd, environment or command');
} else {
  const child = spawn(process.execPath, [fixtureServer], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
`;
}

describe.runIf(process.platform !== 'win32')('materializeMcpServerConfigRecord package-runner integration', () => {
  it('runs a registry pypi producer through the real resolver, private launcher and MCP consumer with no system uv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-p9d-pypi-mcp-'));
    const serverPath = join(root, 'server.mjs');
    const uv = join(root, 'tools', 'uv', 'current', 'bin', 'uv');
    await mkdir(join(root, 'tools', 'uv', 'current', 'bin'), { recursive: true });
    await writeFile(serverPath, buildFixtureServerScript());
    // The external uv/package process is a fixture, while the actual MCP
    // launcher and SDK handshake remain composed through production wiring.
    await writeFile(uv, `#!${process.execPath}\nconst {spawn} = require('node:child_process');
if (process.argv.slice(2).join(' ') !== 'tool run fixture-mcp==1.0.0' || process.env.UV_PYTHON_PREFERENCE !== 'only-managed' || process.env.UV_INDEX_URL !== 'https://authored.invalid') throw new Error('Wrong uv launch');
const child = spawn(${JSON.stringify(process.execPath)}, [process.env.FIXTURE_SERVER], {stdio:'inherit',env:process.env});
child.on('exit', code => process.exit(code ?? 1));\n`);
    await chmod(uv, 0o755);
    const mapped = mapMcpRegistryServerV1({ id: 'pypi', name: 'pypi', nowMs: 1, server: McpRegistryServerV1Schema.parse({
      name: 'example/pypi', version: '1.0.0', status: 'active', description: 'Fixture Python MCP', packages: [{ ecosystem: 'pypi',
        identifier: 'fixture-mcp', version: '1.0.0', transport: 'stdio', environment: [], packageArguments: [], runtimeArguments: [] }], remotes: [],
    }) });
    expect(mapped.ok).toBe(true); if (!mapped.ok) throw new Error('Expected pypi producer');
    expect(mapped.entry.stdio).toMatchObject({ command: 'uvx', args: ['fixture-mcp==1.0.0'] });
    const entry = { ...mapped.entry, env: { FIXTURE_SERVER: { t: 'literal' as const, v: serverPath },
      UV_INDEX_URL: { t: 'literal' as const, v: 'https://authored.invalid' } } };
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [entry], bindings: [{
      id: 'on', serverId: entry.id, enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
    }] });
    const resolved = projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
      context: { machineId: 'machine', directory: root, machinePlatform: null, projectKey: null, agentId: null },
      mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true,
    }), root);
    const processEnv = { ...process.env, HAPPIER_HOME_DIR: root, HOME: root, PATH: '', UV_INDEX_URL: 'https://host.invalid',
      HAPPIER_JS_RUNTIME_PATH: process.execPath };
    let materialized: Awaited<ReturnType<typeof materializeMcpServerConfigRecord>> | undefined;
    try {
      materialized = await materializeMcpServerConfigRecord({ resolved, processEnv, tmpDir: root, deps: {
        resolveStdioLauncherCommand: () => resolveNodeBackedMcpServerCommand({
          distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
          sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true,
        }),
      } });
      expect(materialized.warnings).toEqual([]);
      expect((await probeFixture({ config: materialized.mcpServers.pypi, baseEnv: processEnv })).tools).toMatchObject([{ name: 'fixture_tool' }]);
    } finally { materialized?.cleanup(); await rm(root, { recursive: true, force: true }); }
  });

  it('provisions pnpm on first MCP launch, reuses it, and fails closed when release acquisition is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-fix7-mcp-composed-'));
    const goodHome = join(root, 'home');
    const fixtureServerPath = join(root, 'fixture-server.mjs');
    const tsxHookPath = resolveTsxImportHookPath();
    if (!tsxHookPath) throw new Error('Expected tsx source launcher hook');
    await mkdir(goodHome, { recursive: true });
    await writeFile(fixtureServerPath, `#!/usr/bin/env node\n${buildFixtureServerScript()}`);
    await chmod(fixtureServerPath, 0o755);
    // This executable is the OS/package-manager boundary fixture. It uses an
    // absolute runtime so an empty PATH proves no system runner is selected.
    const binary = Buffer.from(buildFakePnpmScript()
      .replace('#!/usr/bin/env node', `#!${process.execPath}`)
      .replace('spawn(process.execPath, [fixtureServer]', 'spawn(fixtureServer, []'));
    const requests: string[] = [];
    let releaseUnavailable = false;
    const fixture = createServer((request, response) => {
      if (request.url === '/release') {
        requests.push('/release');
        if (releaseUnavailable) {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ message: 'API rate limit exceeded' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ tag_name: 'v10.2.1', assets: [{
          name: process.platform === 'darwin' ? `pnpm-macos-${process.arch}` : `pnpm-linuxstatic-${process.arch}`,
          browser_download_url: `${releaseNetwork.origin}/pnpm`,
          digest: `sha256:${createHash('sha256').update(binary).digest('hex')}`,
        }] }));
        return;
      }
      if (request.url === '/pnpm') {
        requests.push('/pnpm');
        response.writeHead(200, { 'content-length': binary.length });
        response.end(binary);
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    releaseNetwork.origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const processEnv = { ...process.env, HOME: goodHome, HAPPIER_HOME_DIR: goodHome,
      HAPPIER_PNPM_BIN: undefined, PATH: '', HAPPIER_JS_RUNTIME_PATH: process.execPath,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=happier-source`.trim() };
    const settings = McpServersSettingsV1Schema.parse({ v: 1, strictMode: true, servers: [{
      id: 'first-use', name: 'fixture', transport: 'stdio',
      stdio: { command: 'npx', args: ['-y', 'fixture-package@1.0.0'] },
      env: { GOOD_CWD: { t: 'literal', v: realpathSync(goodHome) },
        FIXTURE_MCP_SERVER: { t: 'literal', v: fixtureServerPath } }, createdAt: 0, updatedAt: 0,
    }], bindings: [{ id: 'on', serverId: 'first-use', enabled: true,
      target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }] });
    const resolved = projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({
      context: { machineId: 'machine', directory: root, machinePlatform: null, projectKey: null, agentId: null },
      mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true,
    }), root);
    const materialize = (env: NodeJS.ProcessEnv) => materializeMcpServerConfigRecord({
      resolved, processEnv: env, tmpDir: root, deps: { resolveStdioLauncherCommand: () => resolveNodeBackedMcpServerCommand({
        distEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.mjs'],
        sourceEntrypointSegments: ['mcp', 'launchers', 'stdioMcpServerLauncher.ts'], preferSourceEntrypoint: true,
      }) },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const materialized = await materialize(processEnv);
        try {
          expect(materialized.warnings).toEqual([]);
          const tools = await probeFixture({ config: materialized.mcpServers.fixture, baseEnv: processEnv });
          expect(tools.tools).toMatchObject([{ name: 'fixture_tool' }]);
        } finally { materialized.cleanup(); }
        expect(requests).toEqual(['/release', '/pnpm']);
      }
      releaseUnavailable = true;
      // Existing installations remain usable even when acquisition is down.
      const reused = await materialize(processEnv);
      reused.cleanup();
      expect(requests).toEqual(['/release', '/pnpm']);
      const freshEnv = { ...processEnv, HAPPIER_HOME_DIR: join(root, 'unprovisioned') };
      await expect(materialize(freshEnv))
        .rejects.toThrow('managed runtime unavailable for package-runner command');
      expect(requests).toEqual(['/release', '/pnpm', '/release']);
      releaseUnavailable = false;
      const recovered = await materialize(freshEnv);
      try {
        expect((await probeFixture({ config: recovered.mcpServers.fixture, baseEnv: freshEnv })).tools)
          .toMatchObject([{ name: 'fixture_tool' }]);
      } finally { recovered.cleanup(); }
      expect(requests).toEqual(['/release', '/pnpm', '/release', '/release', '/pnpm']);
    } finally {
      await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  // Match vitest.integration.config.ts: three real launch/probe lifecycles can
  // legitimately outlast the unit harness's single-case 30-second budget.
  }, 60_000);

  it('keeps package-runner stdio MCP servers connectable from a bad session cwd by normalizing them through managed pnpm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-package-runner-integration-'));
    const badCwd = join(root, 'bad-cwd');
    const goodHome = join(root, 'good-home');
    const fixtureServerPath = join(root, 'fixture-server.mjs');
    const fakePnpmPath = join(root, 'pnpm');
    const tsxHookPath = resolveTsxImportHookPath();
    const sourceLauncherPath = fileURLToPath(new URL('../launchers/stdioMcpServerLauncher.ts', import.meta.url));
    const originalCwd = process.cwd();

    if (!tsxHookPath) {
      throw new Error('Expected tsx import hook to be resolvable for source launcher execution');
    }

    await mkdir(badCwd, { recursive: true });
    await mkdir(goodHome, { recursive: true });
    await writeFile(join(badCwd, 'package.json'), '{"name":"bad-cwd"}\n');
    await writeFile(fixtureServerPath, buildFixtureServerScript());
    await writeFile(fakePnpmPath, buildFakePnpmScript());
    await chmod(fakePnpmPath, 0o755);
    const goodHomeRealpath = realpathSync(goodHome);

    try {
      const settings = McpServersSettingsV1Schema.parse({
        v: 1,
        strictMode: true,
        servers: [
          {
            id: 's1',
            name: 'alpha',
            transport: 'stdio',
            stdio: { command: 'npx', args: ['-y', 'fixture-package'] },
            env: {
              GOOD_CWD: { t: 'literal', v: goodHomeRealpath },
              FIXTURE_MCP_SERVER: { t: 'literal', v: fixtureServerPath },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [{ id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 }],
      });

      const resolved = projectMcpServerMaterializationV1(resolveSessionCapabilitiesV1({ context: { machineId: 'm1', directory: badCwd,
        machinePlatform: null, projectKey: null, agentId: null }, mcp: settings, skills: null, selection: {}, agentAcceptsUserMcp: true }), badCwd);
      const materialized = await materializeMcpServerConfigRecord({
        resolved,
        processEnv: { HOME: goodHome, HAPPIER_PNPM_BIN: fakePnpmPath },
        tmpDir: root,
        deps: {
          resolveStdioLauncherCommand: () => ({
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', '--import', tsxHookPath, sourceLauncherPath],
            env: {
              TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=happier-source`.trim(),
            },
          }),
        },
      });

      process.chdir(badCwd);
      const tools = await probeFixture({
        config: materialized.mcpServers.alpha,
        baseEnv: {
          ...process.env,
          HOME: goodHome,
        },
        connectTimeoutMs: 15_000,
        listToolsTimeoutMs: 15_000,
      });

      expect(tools.tools).toMatchObject([{ name: 'fixture_tool' }]);

      const relaunchedTools = await probeFixture({
        config: materialized.mcpServers.alpha,
        baseEnv: { ...process.env, HOME: goodHome },
        connectTimeoutMs: 15_000,
        listToolsTimeoutMs: 15_000,
      });
      expect(relaunchedTools.tools).toMatchObject([{ name: 'fixture_tool' }]);
      materialized.cleanup();
    } finally {
      process.chdir(originalCwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
