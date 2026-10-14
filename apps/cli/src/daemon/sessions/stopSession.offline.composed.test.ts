import { spawn } from 'node:child_process';
import { once } from 'node:events';
import axios, { AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { StopSessionResultSchema, SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol';
import { MachineSessionTerminalCaptureResponseV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { readProcessIdentityByPid } from '../processIdentity';
import { readSessionMarkerForPid, writeSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createOnChildExited } from './onChildExited';
import { createStopSession } from './stopSession';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import { resolveTrackedSessionTerminalHostExitCandidate, shouldRetainTrackedTerminalHostExitMarker } from './disconnectedTerminalHostSupervision';
import { retireExactTerminalControlServiceability, retireStoppedPlainRunnerControlServiceability } from './retireTerminalControlServiceability';
import { reattachTrackedSessionsFromMarkers, readOrphanedDeadPlainRunnerMarkers } from './reattachFromMarkers';
import { publishOrphanedStartupSessionEnds } from './publishOrphanedStartupSessionEnds';

describe.skipIf(process.platform !== 'linux')('offline Stop through physical exit, marker custody and Home recovery', () => {
  it.each(['bound', 'missing-marker', 'live-child'] as const)('releases only durably recoverable dead custody: %s', async wiring => {
    await withConfiguredDaemonTestHome({ prefix: 'offline-stop-' }, async ({ homeDir }) => {
      const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = once(child, 'exit');
      await once(child, 'message');
      const pid = child.pid!;
      const identity = await readProcessIdentityByPid(pid);
      if (!identity) throw new Error('Owned fixture process identity unavailable');
      const sessionId = `offline-stop-${wiring}`;
      const tracked: TrackedSession = { pid, childProcess: child, startedBy: 'daemon', happySessionId: sessionId,
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: identity.processCommandHash,
        stopRequestedAtMs: Date.now(), spawnOptions: { directory: homeDir } };
      if (wiring !== 'missing-marker') await writeSessionMarker({ pid, happySessionId: sessionId, startedBy: 'daemon',
        processStartTimeMs: identity.processStartTimeMs, processCommandHash: identity.processCommandHash });
      let online = false;
      let retired = false;
      const raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ path: homeDir, hostPid: pid, hostProcessStartTimeMs: identity.processStartTimeMs }) });
      const refusal = () => Object.assign(new Error('Home unreachable'), { code: 'ECONNREFUSED' });
      const response = { status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
      // Only genuine HTTP/socket carriers are replaced; all lifecycle, storage,
      // metadata production and strict consumer schemas below remain real.
      const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (!online) throw refusal();
        return { ...response, data: String(url).includes('/v2/sessions/') ? { session: raw } : {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      });
      const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
        if (!online) throw refusal();
        const parsed = SessionMetadataTuplePatchV1Schema.parse(body);
        expect(parsed).toMatchObject({ mode: 'owner_migration', target: { ownerMetadata: { t: 'plain', v: { runtime: {
          terminal: { mode: 'plain', controlServiceabilityV1: { retired: true } } } } } } });
        retired = true;
        return { ...response, data: { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 } } };
      });
      const machine = {
        captureMachineSessionTerminal: async () => {
          if (!online) throw refusal();
          return MachineSessionTerminalCaptureResponseV1Schema.parse({ v: 1, status: 'already_inactive', sessionId });
        },
        finalizeMachineSessionTerminal: async () => { throw new Error('Already inactive must not be finalized again'); },
        enqueueDaemonTerminalExactTurnEnd: async () => { throw new Error('No turn identity must not invent a turn mutation'); },
      } satisfies Pick<ApiMachineClient, 'captureMachineSessionTerminal' | 'finalizeMachineSessionTerminal' | 'enqueueDaemonTerminalExactTurnEnd'>;
      const sessions = new Map([[pid, tracked]]);
      const onExit = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => machine as ApiMachineClient,
        shouldPreserveSessionMarkerOnExit: () => shouldRetainTrackedTerminalHostExitMarker({ tracked, happyHomeDir: homeDir }),
        onFinalTrackedSessionExitStaged: async () => {
          await resolveTrackedSessionTerminalHostExitCandidate({ tracked, pid, happyHomeDir: homeDir, attachmentInfo: null });
        } });
      const retire = async () => {
        const input = { credentials: { token: 'fixture', encryption: null }, sessionId, terminalMode: 'plain' as const,
          expectedRunner: { pid, startTimeMs: identity.processStartTimeMs } };
        return await retireExactTerminalControlServiceability(input);
      };
      const observeExit = async ({ trackedPids }: { trackedPids: readonly number[] }) =>
        await waitForTrackedRunnerProcessesExit({ runners: trackedPids.map(pid => ({ pid })), timeoutMs: 0, pollIntervalMs: 0,
          onExitObserved: onExit });
      try {
        if (wiring !== 'live-child') { child.kill('SIGTERM'); await exited; }
        const stop = createStopSession({ pidToTrackedSession: sessions, areTrackedRunnersExited: observeExit,
          waitForTrackedRunnersExit: observeExit, retireAbsentTerminalControlServiceability: () =>
            retireStoppedPlainRunnerControlServiceability({ sessionId, trackedSession: tracked, publishRetirement: retire }),
          // Refuse OS effect authority for the live-child sensitivity vector.
          retireUpstreamAuthorityBeforeProcessStop: wiring === 'live-child' ? async () => false : undefined });
        const result = StopSessionResultSchema.parse(await stop(sessionId));
        if (wiring === 'bound') {
          expect(result).toEqual({ status: 'stopped' });
          expect(sessions.size).toBe(0);
          expect(await readSessionMarkerForPid(pid)).toMatchObject({ happySessionId: sessionId, processStartTimeMs: identity.processStartTimeMs });
          online = true;
          const recovery = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: sessions });
          expect(recovery.orphanedDeadDaemonSessions).toHaveLength(1);
          expect(await readOrphanedDeadPlainRunnerMarkers()).toEqual(recovery.orphanedDeadDaemonSessions);
          const input = { apiMachine: machine, orphanedDeadDaemonSessions: recovery.orphanedDeadDaemonSessions,
            retireTerminalControlServiceability: async () => { await retire(); } };
          // Machine finality is reachable before the metadata HTTP path. Its
          // success alone must not erase the remaining retirement obligation.
          get.mockRejectedValueOnce(refusal());
          expect(await publishOrphanedStartupSessionEnds(input)).toEqual(recovery.orphanedDeadDaemonSessions);
          expect(await readSessionMarkerForPid(pid)).not.toBeNull();
          expect(await publishOrphanedStartupSessionEnds(input)).toEqual([]);
          expect(retired).toBe(true);
          expect(await readSessionMarkerForPid(pid)).toBeNull();
        } else {
          expect(result.status).toBe('incomplete');
          expect(sessions.get(pid)).toBe(tracked);
          expect(retired).toBe(false);
          if (wiring === 'live-child') expect(child.exitCode === null && child.signalCode === null).toBe(true);
        }
      } finally {
        get.mockRestore(); patch.mockRestore();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    });
  });
});
