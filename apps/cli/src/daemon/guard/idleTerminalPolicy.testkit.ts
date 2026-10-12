import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import type { PtyExitEvent, PtyProcess } from '@/terminal/pty/provider';
import { localServiceProcfsFixture } from '../local/services/inventory/platform/censusFixture.testkit';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { createTerminalProcessRegistry } from '../local/services/inventory/terminalRegistry';
import { listHappierProcessRoots, type HappierProcessRootSource } from '../processes/roots/listHappierProcessRoots';
import { createEndOwnerRemainder } from '../processes/endOwnerRemainder';
import { createLeftBehindPass } from '../processes/leftBehind/leftBehindPass';
import { resolveProcessOwnerScopeKey } from '@/processes/ownerTag';
import { createMachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../vitals/history/minuteHistoryStore';
import { createMachineResourceSummary } from '../resources/machineResourceSummary';
import { createActivityLog } from './activityLog';
import { createIdleTerminalPolicy } from './idleTerminalPolicy';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { notificationSettingsFixture } from '@/notifications/activity/activityNotification.testkit';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';

const target = { serverId: 'home', machineId: 'machine', installationId: 'installation' };
const epoch = Date.UTC(2026, 9, 11);

export async function createIdleTerminalPolicyFixture(releases: Array<() => void | Promise<void>>, options: Readonly<{ relay?: boolean }> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-idle-terminal-'));
  releases.push(() => rm(directory, { recursive: true, force: true }));
  let now = epoch;
  let foreground: number | undefined = 101;
  let nativeReads = 0;
  let heldNative: Readonly<{ entered(): void; waiting: Promise<void>; completed(): void }> | undefined;
  let catalogReady = true;
  const scope = resolveProcessOwnerScopeKey(directory, 'linux');
  const registry = createTerminalProcessRegistry();
  const markers = new Map<number, string>();
  const absent = new Set<number>();
  const endedRoots: HappierProcessRootSource[] = [];
  const procfs = localServiceProcfsFixture([{ pid: 101 }, { pid: 102, ...(options.relay ? { ppid: 101 } : {}) }, { pid: 103 }, { pid: 104, ppid: 101 }]);
  const ownership = createProcessOwnershipRuntime({ daemonScopeKey: scope, platform: 'linux',
    censusDependencies: { platform: 'linux', now: () => now, linuxBoundary: { ...procfs,
      readdir: async path => {
        nativeReads++;
        const held = heldNative; heldNative = undefined;
        if (held) { held.entered(); await held.waiting; }
        const rows = (await procfs.readdir(path)).filter(pid => !absent.has(Number(pid)));
        held?.completed(); return rows;
      },
      readFile: async path => {
        const pid = Number(path.split('/')[2]);
        if (absent.has(pid)) throw Object.assign(new Error('Native process absent'), { code: 'ENOENT' });
        if (path.endsWith('/environ')) return `HAPPIER_PROCESS_OWNER=${markers.get(pid) ?? (options.relay && pid === 102 ? markers.get(101) : '') ?? ''}\0`;
        const result = await procfs.readFile(path);
        if (path === '/proc/101/stat') return String(result).replace('101 101 0 -1', `101 101 0 ${options.relay ? -1 : foreground ?? -1}`);
        if (path === '/proc/102/stat') return String(result).replace('102 102 0 -1', '102 102 0 102');
        if (path === '/proc/103/stat') return String(result).replace('103 103 0 -1', '103 103 0 103');
        if (path === '/proc/104/stat' && absent.has(101)) return String(result).replace(' S 101 ', ' S 1 ');
        return result;
      },
    } }, listRoots: snapshot => listHappierProcessRoots({ snapshot, platform: 'linux', daemonScopeKey: scope,
      terminalRegistry: registry, endedRoots }),
  });
  const leftBehind = createLeftBehindPass({ processOwnershipRuntime: ownership }); releases.push(() => leftBehind.dispose());
  const remainder = createEndOwnerRemainder({ processOwnershipRuntime: ownership, platform: 'linux', daemonScopeKey: scope,
    retainEndedRoots: roots => { endedRoots.push(...roots); }, firstPass: owner => leftBehind.firstPass(owner) });
  const processes: Array<{ pty: PtyProcess; output(text: string): void; exit(): void; kills: number }> = [];
  const terminals = createTerminalPtySessionManager({ now: () => now, env: { SHELL: '/bin/bash', HAPPIER_HOME_DIR: directory }, platform: 'linux',
    terminalRegistry: registry, ownerRemainder: remainder,
    config: readDaemonTerminalPtyConfig({}).sessionManager,
    ptyProvider: { spawn: input => {
      const pid = 101 + processes.length;
      markers.set(pid, input.options.env?.HAPPIER_PROCESS_OWNER ?? '');
      if (pid === 101) markers.set(104, markers.get(pid)!);
      const output = new Set<(text: string) => void>(); const exits = new Set<(event: PtyExitEvent) => void>();
      const process = { kills: 0, output: (text: string) => { for (const listener of output) listener(text); },
        exit: () => { for (const listener of exits) listener({ exitCode: 0 }); },
        pty: { pid, ownedProcessGroupId: options.relay && pid === 101 ? 102 : pid,
          write: () => {}, resize: () => {}, kill: () => { process.kills++; absent.add(pid); },
          onData: (listener: (text: string) => void) => { output.add(listener); return { dispose: () => output.delete(listener) }; },
          onExit: (listener: (event: PtyExitEvent) => void) => { exits.add(listener); return { dispose: () => exits.delete(listener) }; },
        } satisfies PtyProcess };
      processes.push(process); return process.pty;
    } },
  }); releases.push(() => terminals.dispose());
  const historyStore = await createMinuteHistoryStore({ directory: join(directory, 'history') });
  const sampler = createMachineVitalsSampler({ historyStore, readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) } });
  await sampler.start(); releases.push(() => sampler.stop());
  const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, nowMs: () => now, onError: error => { throw error; } });
  releases.push(() => summary.stop());
  const activityLog = await createActivityLog({ activeServerDir: directory, resourceSummary: summary, nowMs: () => now });
  let policy = MachineGuardPolicyV1Schema.parse({});
  const deliveries: unknown[][] = [];
  const notifyWarning: Parameters<typeof createIdleTerminalPolicy>[0]['notifyWarning'] = async warning => {
      await dispatchActivityNotificationAsync({ settings: notificationSettingsFixture({}), pluginNotifications: null,
        notificationChannelCatalog: catalogReady ? { status: 'ready', revision: 1, diagnostics: [], channels: [
          NotificationChannelRecordV1Schema.parse({ v: 1, id: 'terminal-guard-push', kind: 'expo_push', topics: { machines: true } }),
        ] } : { status: 'loading' },
        // Genuine push/network boundary; canonical policy, payload and dispatcher remain real.
        expoPushSender: { sendToAllDevicesAsync: async (...args: unknown[]) => { deliveries.push(args); return true; } },
        event: { topic: 'guard_stop_warning', machineId: target.machineId, terminalId: warning.terminal.terminalId,
          terminalKey: warning.terminal.terminalKey, stopAt: warning.stopAt, rule: 'idle_terminals', idleMs: warning.idleMs },
        nowMs: () => now,
      });
  };
  const owner = createIdleTerminalPolicy({ getTerminals: () => terminals, ownership, activityLog,
    readPolicy: () => policy, readTarget: () => target, nowMs: () => now, notifyWarning,
  });
  const readPlan = (signal: AbortSignal = new AbortController().signal, readSignal?: AbortSignal) => owner.readPlan({ policy, now, signal, ...(readSignal ? { readSignal } : {}) });
  return { terminals, processes, owner, activityLog, summary, readPlan, endedRoots, ownership, deliveries, sampler, readPolicy: () => policy, nowMs: () => now,
    notifyWarning, nativeReads: () => nativeReads, notificationCatalogReady: (ready: boolean) => { catalogReady = ready; },
    holdNativeRead: () => {
      let entered!: () => void; let release!: () => void; let completed!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const finished = new Promise<void>(resolve => { completed = resolve; });
      heldNative = { entered, waiting, completed }; releases.push(release);
      return { entered: started, release, completed: finished };
    },
    enable: (warnBeforeMs = 30_000) => { policy = { ...policy, idleTerminals: { enabled: true, afterMs: 120_000, warnBeforeMs } }; },
    now: (value: number) => { now = epoch + value; }, foreground: (value: number | undefined) => { foreground = value; },
  };
}
