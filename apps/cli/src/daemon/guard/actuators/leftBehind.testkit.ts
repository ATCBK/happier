import type { ProcessCensusDependencies, ProcessCensusRow } from '@/processes/census/processCensus';
import { createProcessOwnershipRuntime } from '../../processes/ownership/processOwnershipRuntime';
import { createLeftBehindTracker } from '../../processes/leftBehind/leftBehindTracker';
import { listHappierProcessRoots, type HappierProcessRootSource } from '../../processes/roots/listHappierProcessRoots';

export const guardLeftBehindOwner = { kind: 'session', sessionId: 'ended-session' } as const;
export const guardLeftBehindAttribution = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'install' };

/** Native transport/clock fixture shared by the policy actuator and composed daemon-loop tests. */
export function createGuardLeftBehindFixture() {
  const scope = '123456789abc';
  let now = 100_000;
  const row = (pid: number, tag?: string): ProcessCensusRow => ({ pid, ppid: 1, pgid: pid,
    start: { startTimeMs: pid, native: `darwin-proc:${pid}:0:${pid}` },
    principal: { kind: 'uid', value: '1000' }, name: 'watcher', argv: ['watcher'],
    memory: { kind: 'rss', bytes: pid * 10 }, cpuTimeUs: 0, ...(tag ? { ownerTag: tag } : {}) });
  const rows = new Map([row(process.pid), row(300, `v1.${scope}.session.${guardLeftBehindOwner.sessionId}`),
    row(301, `v1.${scope}.session.${guardLeftBehindOwner.sessionId}`)].map(item => [item.pid, item]));
  const roots: HappierProcessRootSource[] = [{ owner: guardLeftBehindOwner, pid: 200, start: row(200).start,
    ownerCreatedAtMs: 200, live: false, requesterWorkAttributionV1: guardLeftBehindAttribution }];
  // Only native census transport and clock are substituted. Ownership and confirmation remain real.
  const censusDependencies: ProcessCensusDependencies = { platform: 'darwin', selfPid: process.pid,
    helperExecutablePath: '/fixture/native-helper', now: () => now,
    execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: now, logicalCpus: 1, rows: [...rows.values()] }) }) };
  const ownership = createProcessOwnershipRuntime({ listRoots: snapshot => listHappierProcessRoots({ snapshot,
    selfPid: process.pid, platform: 'darwin', daemonScopeKey: scope, endedRoots: roots }), daemonScopeKey: scope,
    platform: 'darwin', selfPid: process.pid, censusDependencies });
  const tracker = createLeftBehindTracker();
  const observe = async () => {
    const result = await ownership.readOwners({ freshness: 'fresh' });
    if (result.status !== 'ok') throw new Error('Native fixture unavailable');
    tracker.observe({ status: 'ok', capturedAtMs: result.snapshot.capturedAtMs, rows: result.rows });
  };
  return { tracker, ownership, rows, roots, censusDependencies, observe, now: () => now,
    advance(ms: number) { now += ms; } };
}
