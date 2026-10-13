import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('createConfiguredAcpBackend', () => {
  it.runIf(process.platform !== 'win32')('starts a command package through managed pnpm and the selected runtime with no system Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-package-runner-'));
    try {
      const pnpm = join(root, 'pnpm');
      const agent = join(root, 'agent.cjs');
      await writeFile(agent, `#!/usr/bin/env node\nconst readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize' ? {
    protocolVersion: request.params.protocolVersion, agentCapabilities: {}, authMethods: [],
  } : { sessionId: 'managed-runtime-session' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});\n`);
      await chmod(agent, 0o755);
      await writeFile(pnpm, `#!${process.execPath}\nconst { spawn } = require('node:child_process');
if (process.argv[2] !== 'dlx') process.exit(2);
const child = spawn(${JSON.stringify(agent)}, [], { stdio: 'inherit', env: process.env });
child.on('exit', code => process.exit(code ?? 1));\n`);
      await chmod(pnpm, 0o755);
      const backend = await createConfiguredAcpBackend({
        cwd: root,
        backend: {
          backendId: 'npm-command', source: { kind: 'account_configured' }, name: 'npm-command', title: 'Npm command',
          launch: { kind: 'command', command: 'npx', args: ['-y', 'acme-agent@1.2.3', '--acp'] }, env: {},
          capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
        },
        launchEnv: { PATH: root }, env: { HAPPIER_PNPM_BIN: pnpm, PATH: '', HAPPIER_HOME_DIR: root, HAPPIER_JS_RUNTIME_PATH: process.execPath },
      });
      try {
        await expect(backend.startSession()).resolves.toMatchObject({ sessionId: 'managed-runtime-session' });
      } finally { await backend.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('launches an account-configured ACP backend through its configured executable', async () => {
    const backend = await createConfiguredAcpBackend({
      cwd: '/repo',
      backend: {
        backendId: 'custom-backend',
        source: { kind: 'account_configured' },
        name: 'custom-backend',
        title: 'Custom Backend',
        launch: { kind: 'command', command: 'acme-cli', args: ['--acp'] },
        env: {},
        capabilities: {
          supportsLoadSession: true,
          supportsModes: 'yes',
          supportsModels: 'yes',
          supportsConfigOptions: 'unknown',
          promptImageSupport: 'unknown',
        },
      },
      launchEnv: {
        ACP_HOME: '/custom/home',
      },
      env: {
        PATH: '/custom/bin',
      },
      mcpServers: {},
      permissionHandler: {} as never,
    });

    const options = (backend as unknown as {
      options: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> };
    }).options;
    expect(options.command).toBe('acme-cli');
    expect(options.args).toEqual(['--acp']);
    expect(options.env).toEqual(expect.objectContaining({
      ACP_HOME: '/custom/home',
    }));
  });
});
