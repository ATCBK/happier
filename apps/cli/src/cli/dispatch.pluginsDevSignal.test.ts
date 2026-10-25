import http from 'node:http';
import { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import * as daemonStart from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import {
  withConfiguredDaemonTestHome,
  writeDaemonStateFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { PLUGIN_DEVELOPMENT_CONTROL_PATH } from '@/plugins/daemon/controlRoutes';
import type { DaemonPluginDevelopmentControlResult } from '@/plugins/daemon/developmentRoots';
import { captureStdout } from '@/testkit/logger/captureOutput';

import { dispatchCli } from './dispatch';
import { handleDaemonCliCommand } from './commands/daemon';

// Only the daemon's HTTP peer is simulated. Dispatch, command admission,
// persisted daemon discovery and the development command remain real.
async function withDevelopmentDaemon(
  run: (context: { registeredRoots: string[] }) => Promise<void>,
): Promise<void> {
  await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-development-' }, async ({ homeDir }) => {
    const registeredRoots: string[] = [];
    const token = 'development-control-fixture';
    const server = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.headers['x-happier-daemon-token'] !== token) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.url === '/ping') {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === PLUGIN_DEVELOPMENT_CONTROL_PATH) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || !('kind' in body) || body.kind !== 'registerExplicit'
          || !('rootPath' in body) || typeof body.rootPath !== 'string') {
          response.writeHead(400).end(JSON.stringify({ error: 'invalid development request' }));
          return;
        }
        registeredRoots.push(body.rootPath);
        const result = { kind: 'status', status: { roots: [], plugins: [] } } satisfies DaemonPluginDevelopmentControlResult;
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404).end();
    });
    try {
      await new Promise<void>((ready, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', ready);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing daemon fixture address');
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: process.pid,
        httpPort: address.port,
        startedWithCliVersion: configuration.currentCliVersion,
        controlToken: token,
      });
      await run({ registeredRoots });
    } finally {
      await new Promise<void>((closed, reject) => server.close((error) => error ? reject(error) : closed()));
    }
  });
}

describe('dispatchCli command cancellation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['SIGINT', 'SIGTERM', 'parent'] as const)('ends a pending self-restart bulk refresh on %s without resending it', async interrupt => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-self-restart-', env: {
      HAPPIER_DAEMON_RESTART_STABILITY_TIMEOUT_MS: '1',
      HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
    } }, async ({ homeDir }) => {
      let started!: () => void;
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      let release: (() => void) | undefined;
      let requests = 0;
      const server = http.createServer((request, response) => {
        request.resume();
        if (request.url === '/ping') { response.end(JSON.stringify({ ok: true })); return; }
        if (request.url !== '/session-runners/restart-all') { response.writeHead(404).end(); return; }
        requests += 1;
        release = () => response.end(JSON.stringify({ ok: true, mode: 'force_current_cli',
          requestedCount: 0, restartedCount: 0, skippedCount: 0, failedCount: 0, results: [] }));
        started();
      });
      await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
      const state = { pid: process.pid, httpPort: address.port, controlToken: 'test-control',
        startedAt: 1, startedWithCliVersion: configuration.currentCliVersion };
      // Start from an empty fixture Home; only physical spawn is simulated.
      // Dispatch, stop/readiness, persisted discovery and bulk HTTP stay real.
      vi.spyOn(daemonStart, 'spawnDetachedDaemonStartSync').mockImplementation(async () => {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, { ...state, startedAt: 2 });
        return new ChildProcess();
      });
      const output = captureStdout();
      vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`fixture-exit:${code}`); });
      const parent = new AbortController();
      const command = dispatchCli({
        args: ['daemon', 'restart', '--restart-session-runners', '--json'],
        rawArgv: ['happier', 'daemon', 'restart', '--restart-session-runners', '--json'], terminalRuntime: null,
        ...(interrupt === 'parent' ? { signal: parent.signal } : {}),
      }).then(() => 'resolved', error => error instanceof Error ? error.message : String(error));
      try {
        await Promise.race([requestStarted, command.then(result => { throw new Error(`Command ended before bulk observation: ${result}; ${output.text()}`); })]);
        if (interrupt === 'parent') {
          expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
          expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
          parent.abort(new Error('parent retired'));
        } else process.emit(interrupt);
        const outcome = await Promise.race([command, new Promise<null>(resolve => setTimeout(() => resolve(null), 150))]);
        release?.(); await command;
        expect(outcome, 'Cancellation must retire observation while the daemon response is pending').toBe('fixture-exit:1');
        expect(JSON.parse(output.text())).toMatchObject({ ok: false, failedPhase: 'session-runners' });
        expect(requests).toBe(1);
      } finally {
        release?.(); await command;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        output.restore();
      }
    });
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });

  it.each(['SIGINT', 'SIGTERM', 'parent'] as const)('ends a pending runner refresh on %s without restarting it again', async interrupt => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-runner-refresh-' }, async ({ homeDir }) => {
      let started!: () => void;
      const requestStarted = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void;
      let requests = 0;
      const server = http.createServer((request, response) => {
        request.resume();
        if (request.url !== '/session-runners/restart') { response.writeHead(404).end(); return; }
        requests += 1;
        release = () => response.end(JSON.stringify({ ok: true, status: 'restarted', sessionId: 'session' }));
        started();
      });
      await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, {
        pid: process.pid, httpPort: address.port, controlToken: 'test-control',
      });
      const output = captureStdout();
      vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`fixture-exit:${code}`); });
      const parent = new AbortController();
      const execute = interrupt === 'parent' ? handleDaemonCliCommand : dispatchCli;
      const command = execute({
        args: ['daemon', 'restart-session-runners', '--session-id', 'session', '--force-current-cli', '--json'],
        rawArgv: ['happier', 'daemon', 'restart-session-runners'], terminalRuntime: null,
        ...(interrupt === 'parent' ? { signal: parent.signal } : {}),
      }).then(() => 'resolved', error => error instanceof Error ? error.message : String(error));
      try {
        await requestStarted;
        if (interrupt === 'parent') parent.abort(new Error('parent retired'));
        else process.emit(interrupt);
        const outcome = await Promise.race([
          command, new Promise<null>(resolve => setTimeout(() => resolve(null), 150)),
        ]);
        release(); await command;
        expect(outcome).toBe('fixture-exit:1');
        expect(output.text()).toContain(interrupt === 'parent' ? 'parent retired' : `Command interrupted by ${interrupt}`);
        expect(requests).toBe(1);
      } finally {
        release?.(); await command;
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        output.restore();
      }
    });
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops the real development command on %s and releases its listeners', async (interrupt) => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    await withDevelopmentDaemon(async ({ registeredRoots }) => {
      let settled = false;
      let resolveOutput!: () => void;
      const printed = new Promise<void>((ready) => { resolveOutput = ready; });
      vi.spyOn(console, 'log').mockImplementation(() => {
        if (registeredRoots.length > 0) resolveOutput();
      });
      const command = dispatchCli({
        args: ['plugins', 'dev', '.'],
        rawArgv: ['happier', 'plugins', 'dev', '.'],
        terminalRuntime: null,
      }).then(() => { settled = true; });
      try {
        await Promise.race([printed, command.then(() => { throw new Error('Development command stopped before waiting'); })]);
        expect(registeredRoots).toEqual([resolve('.')]);
        expect(settled).toBe(false);
        process.emit(interrupt);
        await expect(command).resolves.toBeUndefined();
        expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
        expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
      } finally {
        if (!settled) {
          process.emit(interrupt);
          await command;
        }
      }
    });
  });

  // `<root> --help` is answered before the command starts, so each root runs its real handler
  // through an invocation that prints and returns without credentials or prompts.
  it.each([
    ['auth', ['auth']],
    ['setup', ['setup', '--non-interactive']],
    ['home', ['home']],
  ] as const)('owns interrupt listeners while the real %s command runs and releases them', async (_root, args) => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    let observedOwnedListeners = false;
    vi.spyOn(console, 'log').mockImplementation(() => {
      observedOwnedListeners ||= process.listenerCount('SIGINT') > before.SIGINT
        && process.listenerCount('SIGTERM') > before.SIGTERM;
    });
    const exitCode = process.exitCode;
    try {
      await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-command-help-' }, async () => {
        await dispatchCli({
          args: [...args],
          rawArgv: ['happier', ...args],
          terminalRuntime: null,
        });
      });
    } finally { process.exitCode = exitCode; }
    expect(observedOwnedListeners).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });

  it('uses the parent signal to stop development without installing process listeners', async () => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const caller = new AbortController();
    await withDevelopmentDaemon(async ({ registeredRoots }) => {
      let settled = false;
      let resolveOutput!: () => void;
      const printed = new Promise<void>((ready) => { resolveOutput = ready; });
      vi.spyOn(console, 'log').mockImplementation(() => {
        if (registeredRoots.length > 0) resolveOutput();
      });
      const command = dispatchCli({
        args: ['plugins', 'dev', '.'],
        rawArgv: ['happier', 'plugins', 'dev', '.'],
        terminalRuntime: null,
        signal: caller.signal,
      }).then(() => { settled = true; });
      try {
        await Promise.race([printed, command.then(() => { throw new Error('Development command stopped before waiting'); })]);
        expect(registeredRoots).toEqual([resolve('.')]);
        expect(settled).toBe(false);
        expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
        expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
        caller.abort();
        await expect(command).resolves.toBeUndefined();
      } finally {
        caller.abort();
        await command;
      }
    });
  });

  it('cleans up owned listeners when the real command exits unsuccessfully', async () => {
    const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const exit = new Error('fixture process exit');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw exit; });
    await withConfiguredDaemonTestHome({ prefix: 'happier-dispatch-command-failure-' }, async () => {
      await expect(dispatchCli({
        args: ['auth', 'unknown-fixture-command'],
        rawArgv: ['happier', 'auth', 'unknown-fixture-command'],
        terminalRuntime: null,
      })).rejects.toBe(exit);
    });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });
});
