import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { createNodePtyProvider, type PtyProcess } from './provider';
import { formatProcessOwnerTag } from '@/processes/ownerTag';
import { createHappierLinuxScopeName, parseHappierLinuxScopeName } from '@/daemon/platform/linux/systemdUserResourceGovernor';
import { buildCgroupProcessLaunchSpec, prepareCgroupProcessLaunchScope } from '@/daemon/platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { createWorkspaceSyncNativeProcessLaunchers } from '@/daemon/startup/workspaceSyncNativeProcessLaunchers';

describe.runIf(process.platform === 'linux' && process.env.HAPPIER_LINUX_SCOPE_LIVE_TEST === '1')('Linux PTY containment native boundary', () => {
  it('contains the workspace sync root while preserving its private descriptor pipe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-linux-sync-scope-fixture-'));
    const observation = join(directory, 'observation.json');
    const launchers = createWorkspaceSyncNativeProcessLaunchers();
    let sidecar: Awaited<ReturnType<typeof launchers.spawnSidecar>> | undefined;
    let targetPid = 0;
    try {
      sidecar = await launchers.spawnSidecar({ executablePath: process.execPath,
        args: ['-e', 'const fs=require("node:fs");const descriptor=fs.readFileSync(3,"utf8");fs.closeSync(3);fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descriptor,cgroup:fs.readFileSync("/proc/self/cgroup","utf8")}));setInterval(()=>{},1000)', observation],
        inheritedBrokerDescriptor: Buffer.from('fixture-descriptor'),
      });
      await vi.waitFor(async () => {
        const result = JSON.parse(await readFile(observation, 'utf8'));
        targetPid = result.pid;
        expect(result.descriptor).toBe('fixture-descriptor');
        expect(parseHappierLinuxScopeName(result.cgroup.trim().split('/').at(-1))?.owner).toEqual({ kind: 'workspace_sync' });
      }, { timeout: 10_000, interval: 10 });
    } finally {
      await sidecar?.stop();
      await launchers.stopRetainedNativeProcesses();
      if (targetPid) await expect(readFile(`/proc/${targetPid}/stat`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('contains a managed launch with empty PATH without disclosing the host transport environment to its target', async () => {
    const serviceId = randomUUID();
    const tag = formatProcessOwnerTag({ happierHomeDir: `/tmp/happier-linux-service-fixture-${serviceId}`, owner: { kind: 'service', serviceId } });
    const scope = await prepareCgroupProcessLaunchScope();
    expect(scope?.kind).toBe('systemd');
    const launch = buildCgroupProcessLaunchSpec({ scope: scope!, unit: createHappierLinuxScopeName(tag), launchSpec: {
      filePath: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({keys:Object.keys(process.env).sort(),path:process.env.PATH,bus:process.env.DBUS_SESSION_BUS_ADDRESS,runtime:process.env.XDG_RUNTIME_DIR,args:process.argv.slice(1),cgroup:require("node:fs").readFileSync("/proc/self/cgroup","utf8")}))', '${HAPPIER_PROCESS_OWNER}', '$$'],
      env: { PATH: '', HAPPIER_PROCESS_OWNER: tag, DBUS_SESSION_BUS_ADDRESS: 'fixture-target-bus', XDG_RUNTIME_DIR: '/fixture-target-runtime' },
    } });
    const { stdout } = await promisify(execFile)(launch.filePath, launch.args, { env: launch.env });
    const result = JSON.parse(stdout);
    // Scope execution itself may supply native INVOCATION_ID/PWD metadata.
    // The host's bus transport and other ambient environment are not target authority.
    expect(result.bus).toBe('fixture-target-bus');
    expect(result.runtime).toBe('/fixture-target-runtime');
    expect(result.keys.some((key: string) => key.startsWith('HAPPIER_DAEMON_SCOPE_TARGET_'))).toBe(false);
    expect(result.keys).not.toContain('HOME');
    expect(result.keys).toContain('HAPPIER_PROCESS_OWNER');
    expect(result.path).toBe('');
    expect(result.args).toEqual(['${HAPPIER_PROCESS_OWNER}', '$$']);
    expect(parseHappierLinuxScopeName(result.cgroup.trim().split('/').at(-1))?.owner).toEqual({ kind: 'service', serviceId });
  });

  it('contains an env-cleared detached child and records terminal readiness latency before and after wrapping', async () => {
    const provider = createNodePtyProvider();
    const preparationStarted = performance.now();
    await provider.prepare?.();
    const preparationMs = performance.now() - preparationStarted;
    const baseline: number[] = [];
    const scoped: number[] = [];
    const terminalId = randomUUID();
    const tag = formatProcessOwnerTag({ happierHomeDir: `/tmp/happier-linux-scope-fixture-${terminalId}`, owner: { kind: 'terminal', terminalId } });
    let observedScope = '';
    for (const owned of [false, true]) {
      for (let sample = 0; sample < 10; sample += 1) {
        let pty: PtyProcess | null = null;
        let output = '';
        let rootPid = 0;
        let childPid = 0;
        let disposed = false;
        const started = performance.now();
        try {
          pty = provider.spawn({ file: '/bin/sh', args: ['-c',
            'read root remaining </proc/self/stat; setsid env -i /bin/sleep 1000 & child=$!; printf "READY:%s:%s\\n" "$root" "$child"; wait "$child"'],
          options: { name: 'xterm-256color', cols: 80, rows: 24, cwd: '/tmp', env: {
            ...process.env, ...(owned ? { HAPPIER_PROCESS_OWNER: tag } : { HAPPIER_PROCESS_OWNER: '' }),
          } } });
          const listener = pty.onData(chunk => {
            output += chunk;
            const observed = /READY:(\d+):(\d+)/.exec(output);
            if (observed) { rootPid = Number(observed[1]); childPid = Number(observed[2]); }
          });
          pty.onExit(() => { disposed = true; });
          await vi.waitFor(() => {
            expect(disposed, output).toBe(false);
            expect(output).toMatch(/READY:\d+:\d+/);
          }, { timeout: 10_000, interval: 1 });
          (owned ? scoped : baseline).push(performance.now() - started);
          const match = /READY:(\d+):(\d+)/.exec(output)!;
          rootPid = Number(match[1]); childPid = Number(match[2]);
          if (owned) {
            // The shell announces its fork immediately; wait until env/setsid
            // have actually exec'd the env-cleared process before inspecting it.
            await vi.waitFor(async () => {
              expect((await readFile(`/proc/${childPid}/comm`, 'utf8')).trim()).toBe('sleep');
              const hasOwner = (await readFile(`/proc/${childPid}/environ`, 'utf8'))
                .split('\0').some(value => value.startsWith('HAPPIER_PROCESS_OWNER='));
              expect(hasOwner).toBe(false);
            }, { timeout: 10_000, interval: 1 });
            const rootCgroup = (await readFile(`/proc/${rootPid}/cgroup`, 'utf8')).trim();
            const childCgroup = (await readFile(`/proc/${childPid}/cgroup`, 'utf8')).trim();
            expect(childCgroup).toBe(rootCgroup);
            observedScope = rootCgroup.split('/').at(-1)!;
            expect(parseHappierLinuxScopeName(observedScope)?.owner).toEqual({ kind: 'terminal', terminalId });
          }
          listener.dispose();
        } finally {
          // These are this fixture's freshly observed live processes. End the
          // detached child first so the shell and systemd scope settle naturally.
          if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
          if (pty) {
            await vi.waitFor(() => { expect(disposed).toBe(true); }, { timeout: 10_000, interval: 10 })
              .catch(() => { pty?.kill('SIGKILL'); });
          }
          if (rootPid) await expect(readFile(`/proc/${rootPid}/stat`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
          if (childPid) await expect(readFile(`/proc/${childPid}/stat`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
    }
    const summary = (values: number[]) => {
      const ordered = [...values].sort((a, b) => a - b);
      return { p50Ms: ordered[4], p95Ms: ordered[9], samplesMs: values };
    };
    console.log(JSON.stringify({ preparationMs, baseline: summary(baseline), scoped: summary(scoped), observedScope }));
  }, 120_000);
});
