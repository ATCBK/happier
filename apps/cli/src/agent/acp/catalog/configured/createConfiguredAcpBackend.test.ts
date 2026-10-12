import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConfiguredAcpBackend } from './createConfiguredAcpBackend';

describe('createConfiguredAcpBackend', () => {
  it('launches a command package runner through managed pnpm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-acp-package-runner-'));
    try {
      const pnpm = join(root, 'pnpm');
      await writeFile(pnpm, '#!/bin/sh\nexit 0\n');
      await chmod(pnpm, 0o755);
      const backend = await createConfiguredAcpBackend({
        cwd: root,
        backend: {
          backendId: 'npm-command', source: { kind: 'account_configured' }, name: 'npm-command', title: 'Npm command',
          launch: { kind: 'command', command: 'npx', args: ['-y', 'acme-agent@1.2.3', '--acp'] }, env: {},
          capabilities: { supportsLoadSession: false, supportsModes: 'unknown', supportsModels: 'unknown', supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' },
        },
        launchEnv: {}, env: { HAPPIER_PNPM_BIN: pnpm, PATH: '' },
      });
      const options = (backend as unknown as { options: { command: string; args: readonly string[] } }).options;
      expect(options.command).toBe(pnpm);
      expect(options.args).toEqual(['dlx', 'acme-agent@1.2.3', '--acp']);
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
