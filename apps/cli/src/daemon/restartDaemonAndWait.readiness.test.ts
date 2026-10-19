import http from 'node:http';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { readDaemonState, writeDaemonState } from '@/persistence';
import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';
import { withConfiguredDaemonTestHome, writeDaemonStateFixture } from './testkit/fakeDaemonLifecycle.testkit';

const { spawnDaemon } = vi.hoisted(() => ({ spawnDaemon: vi.fn() }));
// Process launch is the OS boundary; the restart, wait, persistence and HTTP control owners stay real.
vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({ spawnDetachedDaemonStartSync: spawnDaemon }));

let restartDaemonAndWait: typeof import('./restartDaemonAndWait')['restartDaemonAndWait'];
beforeAll(async () => { ({ restartDaemonAndWait } = await import('./restartDaemonAndWait')); }, 300_000);
afterEach(() => { spawnDaemon.mockReset(); });

describe('daemon restart readiness', () => {
  it('waits past the startup checkpoint for the live successor to answer authenticated control', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-readiness-', env: {
      HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      HAPPIER_DAEMON_START_WAIT_POLL_MS: '1',
      HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS: '1',
    } }, async ({ homeDir }) => {
      let probes = 0;
      const server = http.createServer((req, res) => {
        if (req.url !== '/ping' || req.headers['x-happier-daemon-token'] !== 'successor-token') {
          res.writeHead(401).end();
          return;
        }
        probes += 1;
        if (probes === 1) {
          // A real unavailable response crosses the configured checkpoint before readiness.
          setTimeout(() => res.writeHead(503).end(), 20);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
      const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
      if (!child.pid) throw new Error('Missing successor PID');
      const pid = child.pid;
      spawnDaemon.mockImplementationOnce(async () => {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
          pid, httpPort: address.port, controlToken: 'successor-token',
        });
        return Object.assign(child, { detachedDaemonPid: pid });
      });
      try {
        await expect(restartDaemonAndWait()).resolves.toEqual({ ok: true });
        expect((await readDaemonState())?.pid).toBe(pid);
        expect(probes).toBeGreaterThan(1);
      } finally {
        await stopChild(child);
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  it('reports start failure when the owned successor exits before publishing readiness', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-restart-exited-', env: {
      HAPPIER_DAEMON_START_WAIT_TIMEOUT_MS: '1',
      HAPPIER_DAEMON_START_WAIT_POLL_MS: '1',
    } }, async () => {
      const child = spawnInlineNodeTestProcess('process.exit(1)');
      await once(child, 'exit');
      spawnDaemon.mockResolvedValueOnce(Object.assign(child, { detachedDaemonPid: child.pid }));
      await expect(restartDaemonAndWait()).resolves.toEqual({
        ok: false, failedPhase: 'start', daemonStatusAfterFailure: 'not-running',
      });
    });
  });

  it('confirms self-replacement after its checkpoint while the successor process is still starting', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-self-restart-readiness-' }, async () => {
      const { requestDaemonSelfRestart } = await import('./lifecycle/requestDaemonSelfRestart');
      let probes = 0;
      const server = http.createServer((_req, res) => {
        probes += 1;
        if (probes === 1) setTimeout(() => res.writeHead(503).end(), 20);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok' }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
      const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
      if (!child.pid) throw new Error('Missing successor PID');
      writeDaemonState({ pid: child.pid, httpPort: address.port, startedAt: Date.now(),
        startedWithCliVersion: 'test', controlToken: 'successor-token', runtimeId: 'test-runtime' });
      const exitProcess = vi.fn();
      try {
        await expect(requestDaemonSelfRestart({
          ownPid: process.pid, expectedCliVersion: 'test', runtimeId: 'test-runtime', timeoutMs: 1, pollMs: 1,
          spawnDetachedDaemonStartSyncImpl: async () => Object.assign(child, { detachedDaemonPid: child.pid }),
          exitProcess,
        })).resolves.toEqual({ status: 'exited' });
        expect(exitProcess).toHaveBeenCalledWith(0);
      } finally {
        await stopChild(child);
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  });

  it('keeps the incumbent alive when the self-replacement process exits without readiness', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-self-restart-exited-' }, async () => {
      const { requestDaemonSelfRestart } = await import('./lifecycle/requestDaemonSelfRestart');
      const child = spawnInlineNodeTestProcess('process.exit(1)');
      await once(child, 'exit');
      const exitProcess = vi.fn();
      await expect(requestDaemonSelfRestart({
        ownPid: process.pid, expectedCliVersion: 'test', timeoutMs: 1, pollMs: 1,
        spawnDetachedDaemonStartSyncImpl: async () => Object.assign(child, { detachedDaemonPid: child.pid }),
        exitProcess,
      })).resolves.toEqual({ status: 'replacement_not_confirmed' });
      expect(exitProcess).not.toHaveBeenCalled();
    });
  });
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
