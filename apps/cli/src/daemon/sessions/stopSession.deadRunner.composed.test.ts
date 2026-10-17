import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ApiMachineClient } from '@/api/apiMachine';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { waitForExistingSessionExitIfStopRequested } from './waitForExistingSessionExitIfStopRequested';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import { readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { resolveTrackedSessionTerminalHostExitCandidate, shouldRetainTrackedTerminalHostExitMarker } from './disconnectedTerminalHostSupervision';
import { listSessionMarkers, writeSessionMarker } from '../sessionRegistry';

describe('Stop of an already-dead tracked runner', () => {
  it.each(['plain', 'missing-owned-host', 'missing-owned-launch-host'] as const)('settles final Session presence and inventory, retaining truthful Home retry custody (%s)', async (presentation) => {
    await withConfiguredDaemonTestHome({ prefix: 'dead-runner-stop-' }, async ({ homeDir }) => {
      const child = spawn(process.execPath, ['-e', "process.send('ready')"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = once(child, 'exit');
      await once(child, 'message');
      await exited;
      const pid = child.pid!;
      const sessionId = 'dead-runner-stop';
      const tracked: TrackedSession = { pid, childProcess: child, startedBy: 'daemon', happySessionId: sessionId,
        ...(presentation !== 'plain' ? {
          hostedTerminal: { mode: 'tmux' as const },
          publishedTerminalControlServiceabilityAttachmentId: 'already-retired-host',
        } : {}),
        ...(presentation === 'missing-owned-launch-host' ? {
          spawnOptions: { directory: homeDir, terminal: { mode: 'tmux' as const } },
        } : {}),
      };
      await writeSessionMarker({ pid, happySessionId: sessionId, startedBy: 'daemon', cwd: homeDir });
      const sessions = new Map([[pid, tracked]]);
      let homeAvailable = false;
      let finalPresenceObserved = false;
      let unexpectedExitObserved = false;
      // The Machine transport is the external boundary; stop, physical probes,
      // exit classification, durable staging and inventory cleanup remain real.
      const machine = {
        captureMachineSessionTerminal: async () => {
          if (!homeAvailable) throw new Error('Home unavailable');
          finalPresenceObserved = true;
          return { v: 1, status: 'already_inactive', sessionId } as const;
        },
      } satisfies Pick<ApiMachineClient, 'captureMachineSessionTerminal'>;
      const onExit = createOnChildExited({
        pidToTrackedSession: sessions,
        spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(),
        getApiMachineForSessions: () => machine as ApiMachineClient,
        onUnexpectedExit: () => { unexpectedExitObserved = true; },
        shouldPreserveSessionMarkerOnExit: ({ trackedSession }) => shouldRetainTrackedTerminalHostExitMarker({
          tracked: trackedSession, happyHomeDir: homeDir,
        }),
        onFinalTrackedSessionExitStaged: async ({ pid, trackedSession }) => {
          const attachmentInfo = await readTerminalHostAttachmentInfo({ happyHomeDir: homeDir, sessionId });
          // Production exit wiring delegates final-host selection to this real owner.
          const candidate = await resolveTrackedSessionTerminalHostExitCandidate({
            tracked: trackedSession, pid, happyHomeDir: homeDir, attachmentInfo,
          });
          expect(candidate).toBeNull();
        },
      });
      const stop = createStopSession({
        pidToTrackedSession: sessions,
        areTrackedRunnersExited: ({ trackedPids }) => waitForTrackedRunnerProcessesExit({
          runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0,
        }),
        waitForTrackedRunnersExit: async ({ trackedPids }) => {
          await waitForExistingSessionExitIfStopRequested({
            sessionId, pidToTrackedSession: sessions, timeoutMs: 0, pollIntervalMs: 0,
            onExitObserved: onExit,
          });
          return trackedPids.every(pid => !sessions.has(pid));
        },
      });

      expect((await stop(sessionId)).status).toBe('incomplete');
      expect(sessions.get(pid)).toBe(tracked);
      expect(finalPresenceObserved).toBe(false);
      expect(unexpectedExitObserved).toBe(false);
      homeAvailable = true;
      expect(await stop(sessionId)).toEqual({ status: 'stopped' });
      expect(finalPresenceObserved).toBe(true);
      expect(sessions.size).toBe(0);
      expect(await listSessionMarkers()).toEqual([]);
      expect(unexpectedExitObserved).toBe(false);
    });
  });
});
