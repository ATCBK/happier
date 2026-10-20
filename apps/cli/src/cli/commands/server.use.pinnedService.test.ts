import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The service manager (OS boundary) runs the Home's pinned unit.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[] = [], options?: Parameters<typeof actual.spawnSync>[2]) => (
      command === 'systemctl' && args.includes('show')
        ? { status: 0, stdout: 'ActiveState=active\nSubState=running\n', stderr: '' }
        : actual.spawnSync(command, [...args], options ?? {})
    ),
  };
});

import { reloadConfiguration } from '@/configuration';
import { writeInstalledLinuxDaemonService } from '@/daemon/service/installedDaemonServices.testkit';
import { resolveDaemonServiceSystemdUnitLabel } from '@/daemon/service/plan';
import { addServerProfile } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { handleServerCommand } from './server';

/**
 * `server use <Home>` when the Home already has its own pinned background service: the user's
 * default-following service must not be told (or restarted) to follow it — it stands by, and the
 * caller learns so on the human and the `--json` path alike.
 */
describe('happier server use <Home with its own background service>', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_DAEMON_SERVICE_PLATFORM',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  ]);
  let root = '';
  let homeId = '';
  let pinnedLabel = '';

  beforeEach(async () => {
    root = await createTempDir('happier-server-use-pinned-');
    const userHomeDir = join(root, 'user');
    const happierHomeDir = join(userHomeDir, '.happier');
    envScope.patch({
      HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: userHomeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
    });
    reloadConfiguration();
    await addServerProfile({ name: 'Work', serverUrl: 'https://work.example.test', webappUrl: 'https://work.example.test', use: true });
    const home = await addServerProfile({ name: 'Home', serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test', use: false });
    homeId = home.id;
    pinnedLabel = resolveDaemonServiceSystemdUnitLabel(home.id, 'stable', 'pinned');
    writeInstalledLinuxDaemonService({ userHomeDir, happierHomeDir, targetMode: 'default-following' });
    writeInstalledLinuxDaemonService({ userHomeDir, happierHomeDir, targetMode: 'pinned', serverId: home.id, serverUrl: home.serverUrl });
    reloadConfiguration();
  });

  afterEach(async () => {
    envScope.restore();
    reloadConfiguration();
    if (root) await removeTempDir(root);
  });

  it('reports the pinned service and never asks the default one to follow the Home', async () => {
    const output = captureConsoleText();
    try {
      await handleServerCommand(['use', homeId]);
    } finally {
      output.restore();
    }

    const text = output.text();
    expect(text).toContain(pinnedLabel);
    expect(text).toContain('stands by');
    expect(text).not.toContain('so it now follows');
    expect(text).not.toContain('Authenticate Happier against');
  });

  it('reports the same follow-up in the --json envelope', async () => {
    const output = captureConsoleText();
    try {
      await handleServerCommand(['use', homeId, '--json']);
    } finally {
      output.restore();
    }

    const parsed = JSON.parse(output.text().trim());
    expect(parsed).toMatchObject({ ok: true, kind: 'server_use', data: { active: { id: homeId } } });
    expect(parsed.data.backgroundService).toEqual({
      servedByPinnedService: pinnedLabel,
      commands: ['happier service restart'],
    });
  });
});
