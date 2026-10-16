import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildRemoteFirstPartyPromotionCommand,
  buildRemoteFirstPartyRetentionCommand,
  buildRemoteFirstPartyVersionInventoryCommand,
  resolveRemoteFirstPartyInstallLayout,
} from './remoteFirstPartyInstallPath.js';

describe('remote first-party install layout', () => {
  it('does not remove current or previous when promotion retries a protected version or has an invalid payload', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'happier-promote-failure-'));
    const installRoot = join(home, '.happier', 'cli');
    try {
      for (const id of ['1.0.0', '2.0.0']) {
        await mkdir(join(installRoot, 'versions', id), { recursive: true });
        await writeFile(join(installRoot, 'versions', id, 'happier'), id, { mode: 0o755 });
      }
      await symlink('versions/2.0.0', join(installRoot, 'current'));
      await symlink('versions/1.0.0', join(installRoot, 'previous'));
      for (const versionId of ['2.0.0', '1.0.0', '3.0.0']) {
        const command = buildRemoteFirstPartyPromotionCommand({
          layout: resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', versionId }),
          payloadRootExpression: '"$missing_payload"',
        });
        await expect(promisify(execFile)('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home, missing_payload: join(home, 'missing') } })).rejects.toMatchObject({ code: 1 });
        expect(await readFile(join(installRoot, 'current', 'happier'), 'utf8')).toBe('2.0.0');
        expect(await readFile(join(installRoot, 'previous', 'happier'), 'utf8')).toBe('1.0.0');
      }
      const payload = join(home, 'retry-payload');
      await mkdir(payload);
      await writeFile(join(payload, 'happier'), 'replacement');
      for (const versionId of ['2.0.0', '1.0.0']) {
        const command = buildRemoteFirstPartyPromotionCommand({
          layout: resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', versionId }),
          payloadRootExpression: '"$retry_payload"',
        });
        await promisify(execFile)('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home, retry_payload: payload } });
        expect(await readFile(join(installRoot, 'current', 'happier'), 'utf8')).toBe(versionId);
        expect(await readFile(join(installRoot, 'previous', 'happier'), 'utf8')).toBe(versionId === '2.0.0' ? '1.0.0' : '2.0.0');
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('rechecks activation pointers before applying a previously resolved prune set', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'happier-prune-guard-'));
    const installRoot = join(home, '.happier', 'cli');
    const layout = resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', versionId: 'unused' });
    const run = async (command: string) => promisify(execFile)('/bin/sh', ['-c', command], { env: { ...process.env, HOME: home } });
    try {
      for (const id of ['1.0.0', '2.0.0', '3.0.0']) await mkdir(join(installRoot, 'versions', id), { recursive: true });
      await symlink('versions/3.0.0', join(installRoot, 'current'));
      await symlink('versions/2.0.0', join(installRoot, 'previous'));
      const inventory = (await run(buildRemoteFirstPartyVersionInventoryCommand(layout))).stdout;
      const command = buildRemoteFirstPartyRetentionCommand({ layout, inventory });
      expect(command).not.toBeNull();
      await rm(join(installRoot, 'current'));
      await symlink('versions/1.0.0', join(installRoot, 'current'));
      await run(command!);
      expect((await stat(join(installRoot, 'versions', '1.0.0'))).isDirectory()).toBe(true);
      for (const inventory of ['version=..', 'version=../outside', 'version=unsafe;command']) {
        expect(() => buildRemoteFirstPartyRetentionCommand({ layout, inventory })).toThrow('Invalid remote version inventory');
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it.each(['.', '..'])('refuses a version id that addresses a parent instead of a version: %s', (versionId) => {
    expect(() => resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', versionId })).toThrow();
  });
  it('builds the canonical versioned install layout for every remote installer strategy', () => {
    expect(resolveRemoteFirstPartyInstallLayout({
      componentId: 'happier-cli',
      channel: 'preview',
      versionId: "preview-1'break-quote",
    })).toEqual({
      remoteHomeDir: '$HOME/.happier',
      installRoot: '$HOME/.happier/cli-preview',
      versionsDir: '$HOME/.happier/cli-preview/versions',
      versionDir: '$HOME/.happier/cli-preview/versions/preview-1-break-quote',
      currentPath: '$HOME/.happier/cli-preview/current',
      previousPath: '$HOME/.happier/cli-preview/previous',
      binaryPath: '$HOME/.happier/cli-preview/current/happier',
    });
  });

  it('promotes the next version and preserves the previous target in a real remote shell', async () => {
    if (process.platform === 'win32') return; // The shared promotion command runs on POSIX targets.
    const root = await mkdtemp(join(tmpdir(), 'happier-promote-'));
    const home = join(root, 'home with spaces');
    const payload = join(root, 'payload');
    try {
      await mkdir(home);
      for (const versionId of ['1.2.3', '1.2.4']) {
        await mkdir(payload, { recursive: true });
        await writeFile(join(payload, 'happier'), '#!/bin/sh\nexit 0\n');
        const stagedBinary = await stat(join(payload, 'happier'));
        const command = buildRemoteFirstPartyPromotionCommand({
          layout: resolveRemoteFirstPartyInstallLayout({ componentId: 'happier-cli', channel: 'stable', versionId }),
          payloadRootExpression: '"$payload_root"',
        });
        await promisify(execFile)('/bin/sh', ['-c', command], {
          cwd: root, env: { ...process.env, HOME: home, payload_root: payload },
        });
        // Same-filesystem staging must not allocate a second payload's worth of disk.
        const installedBinary = await stat(join(home, '.happier', 'cli', 'versions', versionId, 'happier'));
        expect({ device: installedBinary.dev, inode: installedBinary.ino }).toEqual({ device: stagedBinary.dev, inode: stagedBinary.ino });
      }
      const installRoot = join(home, '.happier', 'cli');
      expect(await readlink(join(installRoot, 'current'))).toBe(join(installRoot, 'versions', '1.2.4'));
      expect(await readlink(join(installRoot, 'previous'))).toBe(join(installRoot, 'versions', '1.2.3'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
