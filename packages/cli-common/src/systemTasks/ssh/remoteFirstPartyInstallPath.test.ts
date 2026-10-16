import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  buildRemoteFirstPartyPromotionCommand,
  resolveRemoteFirstPartyInstallLayout,
} from './remoteFirstPartyInstallPath.js';

describe('remote first-party install layout', () => {
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
