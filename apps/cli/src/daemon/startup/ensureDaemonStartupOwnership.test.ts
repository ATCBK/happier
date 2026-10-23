import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('ensureDaemonStartupOwnership', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    'HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK',
    'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.doUnmock('@/daemon/doctor');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('fails closed when daemon state is missing but a relay process has proven current scope', async () => {
    await withTempDir('happier-daemon-startup-process-only-owner-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      });
      vi.resetModules();
      const daemonCommand = `${process.execPath} ${join(process.cwd(), 'package-dist/index.mjs')} daemon start-sync`;
      vi.doMock('@/daemon/doctor', () => ({
        findAllHappyProcesses: vi.fn(async () => [
          {
            pid: 4242,
            command: daemonCommand,
            type: 'daemon',
            daemonOwnershipEnvironmentVariables: {
              HAPPIER_HOME_DIR: homeDir,
              HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
            },
          },
        ]),
      }));

      const [{ ensureDaemonStartupOwnership }, { logger }] = await Promise.all([
        import('./ensureDaemonStartupOwnership'),
        import('@/ui/logger'),
      ]);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        return undefined as never;
      }) as typeof process.exit);

      const result = await ensureDaemonStartupOwnership({
        takeoverRequested: false,
        startupSource: 'manual',
        runtimeId: 'runtime-test',
      });

      expect(result).toEqual({ action: 'exit' });
      expect(exitSpy).toHaveBeenCalledWith(1);
      const logContent = await readFile(logger.logFilePath, 'utf8');
      expect(logContent).toContain('Relay ownership conflict prevented daemon startup');
      expect(logContent).toContain('Another relay owner already owns this relay');
    });
  });

  it('fails closed instead of force-stopping a state-less relay process with proven current scope when takeover is requested', async () => {
    await withTempDir('happier-daemon-startup-process-only-takeover-', async (homeDir) => {
      const daemonCommand = `${process.execPath} ${join(process.cwd(), 'package-dist/index.mjs')} daemon start-sync`;
      const processOnlyOwner = {
        pid: 4242,
        command: daemonCommand,
        type: 'daemon',
        daemonOwnershipEnvironmentVariables: {
          HAPPIER_HOME_DIR: homeDir,
          HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
        },
      };
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_DAEMON_PROCESS_INVENTORY_FALLBACK: '1',
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      });
      vi.resetModules();
      vi.doMock('@/daemon/doctor', () => ({
        findAllHappyProcesses: vi.fn(async () => [processOnlyOwner]),
        findHappyProcessByPid: vi.fn(async (pid: number) => (pid === processOnlyOwner.pid ? processOnlyOwner : null)),
      }));

      const { ensureDaemonStartupOwnership } = await import('./ensureDaemonStartupOwnership');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === processOnlyOwner.pid && signal === 0) {
          throw new Error('process exited');
        }
        return true;
      }) as typeof process.kill);

      await expect(ensureDaemonStartupOwnership({
        takeoverRequested: true,
        startupSource: 'manual',
        runtimeId: 'runtime-test',
      })).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'process_identity_unverified',
        pid: processOnlyOwner.pid,
      });

      expect(killSpy).not.toHaveBeenCalledWith(processOnlyOwner.pid, 'SIGTERM');
    });
  });

  it('stops the default-following daemon serving this server when the pinned service starts second', async () => {
    await withTempDir('happier-daemon-startup-pinned-after-default-', async (homeDir) => {
      const serviceScope = createEnvKeyScope(['HAPPIER_DAEMON_SERVICE_TARGET_MODE']);
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'home',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: homeDir,
      });
      serviceScope.patch({ HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned' });
      try {
        vi.resetModules();
        const stopDaemonMock = vi.fn(async () => ({ status: 'stopped' }));
        const { resolveDaemonServiceLaunchdLabel } = await import('@/daemon/service/plan');
        vi.doMock('@/daemon/ownership/evaluateCurrentDaemonOwner', async (importOriginal) => ({
          ...await importOriginal<typeof import('@/daemon/ownership/evaluateCurrentDaemonOwner')>(),
          evaluateCurrentDaemonOwner: vi.fn(async () => ({
            kind: 'compatible' as const,
            owner: {
              status: 'running' as const,
              source: 'state' as const,
              state: {
                pid: 4343,
                httpPort: 43140,
                startedAt: Date.now(),
                startedWithCliVersion: '0.3.0',
                startupSource: 'background-service' as const,
                serviceLabel: resolveDaemonServiceLaunchdLabel('default', 'stable', 'default-following'),
              },
              currentCliVersion: '0.3.0',
              currentPublicReleaseChannel: 'stable' as const,
              versionMatches: true,
              releaseChannelMatches: true,
              serviceManaged: true,
              startupSource: 'background-service' as const,
            },
          })),
        }));
        // The daemon control socket is the boundary the takeover talks through.
        vi.doMock('@/daemon/controlClient', async (importOriginal) => ({
          ...await importOriginal<typeof import('@/daemon/controlClient')>(),
          stopDaemon: stopDaemonMock,
        }));

        const { ensureDaemonStartupOwnership } = await import('./ensureDaemonStartupOwnership');
        const result = await ensureDaemonStartupOwnership({
          takeoverRequested: true,
          startupSource: 'background-service',
          runtimeId: 'runtime-pinned',
        });

        expect(result).toEqual({ action: 'continue' });
        expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      } finally {
        serviceScope.restore();
        vi.doUnmock('@/daemon/ownership/evaluateCurrentDaemonOwner');
        vi.doUnmock('@/daemon/controlClient');
      }
    });
  });
});
