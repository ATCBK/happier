import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { spawnSleepyDetachedProcess } from './testkit/fakeDaemonLifecycle.testkit';

const { readFileSyncMock, readFileMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn(), readFileMock: vi.fn() }));
// Only the filesystem boundary is replaced; selection, definitions and status remain real.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: readFileSyncMock,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: readFileMock,
}));

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_TARGET_MODE',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
]);

describe('multiDaemon daemon ownership path resolution', () => {
  let homeDir = '';

  beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    readFileSyncMock.mockReset();
    readFileSyncMock.mockImplementation(fs.readFileSync);
    const fsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    readFileMock.mockReset();
    readFileMock.mockImplementation(fsPromises.readFile);
    envScope.patch({ HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
  });

  afterEach(() => {
    envScope.restore();
    if (homeDir && homeDir.startsWith(tmpdir())) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    vi.resetModules();
  });

  it('prefers the canonical daemon state file and still reports a legacy ring-scoped daemon state path when only that legacy file exists', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-ring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    // Seed a minimal settings file with a cloud server profile so the list is deterministic.
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: 12345,
          httpPort: 7777,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.0',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
  });

  it('uses the canonical daemon state file for status even when the current release ring is dev', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-canonical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7778,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.1',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.state.json'));
    expect(cloud?.daemon.pid).toBe(process.pid);
    expect(cloud?.daemon.running).toBe(true);
  });

  it('falls back to a valid legacy ring-scoped daemon state when the canonical file is unreadable', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-canonical-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'daemon.state.json'), '{not-json', 'utf-8');
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7779,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.2',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
    expect(cloud?.daemon.pid).toBe(process.pid);
    expect(cloud?.daemon.running).toBe(true);
  });

  it('skips a stale canonical daemon state and uses a later live legacy ring-scoped state', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-stale-canonical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: Number.MAX_SAFE_INTEGER,
          httpPort: 7780,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.3',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const sleepy = spawnSleepyDetachedProcess();
    try {
      writeFileSync(
        join(serverDir, 'daemon.dev.state.json'),
        JSON.stringify(
          {
            pid: sleepy.pid,
            httpPort: 7781,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.4',
          },
          null,
          2,
        ),
        'utf-8',
      );

      vi.resetModules();
      const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

      const entries = await listDaemonStatusesForAllKnownServers();
      const cloud = entries.find((entry) => entry.serverId === 'cloud');
      expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
      expect(cloud?.daemon.pid).toBe(sleepy.pid);
      expect(cloud?.daemon.running).toBe(true);
      expect(cloud?.daemon.staleStateFile).toBe(false);
    } finally {
      await sleepy.kill();
    }
  });

  it('reports for each server the background service that serves it: its pinned service, or the default one for the selected server', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-service-per-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const happierHomeDir = join(homeDir, '.happier');
    envScope.patch({
      HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_RELEASE_RING: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: undefined,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: happierHomeDir,
      HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: undefined,
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
    });
    mkdirSync(happierHomeDir, { recursive: true });
    const profile = (id: string, url: string) => ({ id, name: id, serverUrl: url, webappUrl: url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
    writeFileSync(join(happierHomeDir, 'settings.json'), JSON.stringify({
      schemaVersion: 6,
      activeServerId: 'cloud',
      servers: {
        cloud: profile('cloud', 'https://api.happier.dev'),
        personal: profile('personal', 'https://personal.example.test'),
        company: profile('company', 'https://company.example.test'),
      },
    }), 'utf-8');

    const { planDaemonServiceInstall } = await import('./service/plan');
    const writeServiceDefinition = (params: Readonly<{ targetMode: 'pinned' | 'default-following'; serverId: string; serverUrl: string }>) => {
      const plan = planDaemonServiceInstall({
        platform: 'linux',
        channel: 'stable',
        targetMode: params.targetMode,
        instanceId: params.serverId,
        activeServerId: params.serverId,
        userHomeDir: homeDir,
        happierHomeDir,
        serverUrl: params.serverUrl,
        webappUrl: params.serverUrl,
        publicServerUrl: params.serverUrl,
        nodePath: '/usr/local/bin/happier',
        entryPath: '',
      });
      const file = plan.files[0]!;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, 'utf-8');
      return file.path;
    };
    const personalServicePath = writeServiceDefinition({ targetMode: 'pinned', serverId: 'personal', serverUrl: 'https://personal.example.test' });
    const defaultServicePath = writeServiceDefinition({ targetMode: 'default-following', serverId: 'default', serverUrl: 'https://api.happier.dev' });

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');
    const entries = await listDaemonStatusesForAllKnownServers();
    const byId = new Map(entries.map((entry) => [entry.serverId, entry]));

    expect(byId.get('personal')?.service).toMatchObject({ installed: true, installedPath: personalServicePath });
    expect(byId.get('cloud')?.service).toMatchObject({ installed: true, installedPath: defaultServicePath });
    expect(byId.get('company')?.service.installed).toBe(false);
    expect(byId.get('company')?.service.installedPath).not.toBe(defaultServicePath);
    const cloudPinnedPath = writeServiceDefinition({ targetMode: 'pinned', serverId: 'cloud', serverUrl: 'https://api.happier.dev' });
    const withPinnedWinner = await listDaemonStatusesForAllKnownServers();
    expect(withPinnedWinner.find((entry) => entry.serverId === 'cloud')?.service)
      .toMatchObject({ installed: true, installedPath: cloudPinnedPath });
  });

  it.each(['EACCES', 'EIO'])('preserves %s from authoritative definition reads rather than claiming absence (A15-03)', async (code) => {
    homeDir = join(tmpdir(), `happier-w16-read-error-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
      HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_SERVICE_TARGET_MODE: undefined,
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: undefined,
    });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
      activeServerId: 'cloud',
      servers: { cloud: { id: 'cloud', name: 'Cloud', serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev' } },
    }), 'utf-8');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const cause = Object.assign(new Error('cannot read service definition'), { code });
    readFileSyncMock.mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith('.service')) throw cause;
      return fs.readFileSync(...args);
    });
    const fsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    readFileMock.mockImplementation((...args: Parameters<typeof fsPromises.readFile>) => {
      if (String(args[0]).endsWith('.service')) return Promise.reject(cause);
      return fsPromises.readFile(...args);
    });
    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');
    await expect(listDaemonStatusesForAllKnownServers()).rejects.toMatchObject({ code: 'service_inventory_unavailable', cause });

    // The same authoritative reader governs inventory; optional mode metadata remains nullable.
    const { discoverInstalledDaemonServiceEntries, readInstalledDaemonServiceAutostartMode } = await import('./service/discoverInstalledDaemonServiceEntries');
    const servicePath = join(homeDir, '.config', 'systemd', 'user', 'happier-daemon.default.service');
    mkdirSync(dirname(servicePath), { recursive: true });
    writeFileSync(servicePath, '[Service]\nExecStart=/managed/happier daemon start-sync\n', 'utf-8');
    expect(readInstalledDaemonServiceAutostartMode({ platform: 'linux', path: servicePath })).toBeNull();
    await expect(discoverInstalledDaemonServiceEntries({
      platform: 'linux', userHomeDir: homeDir, happierHomeDir: homeDir, mode: 'user', serversById: {},
    })).rejects.toMatchObject({ code: 'service_inventory_unavailable', cause });
  });
});
