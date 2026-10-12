import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { getPriority, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Scheduling priority is an OS boundary; keep the shared launch policy real.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, getPriority: vi.fn(() => 0) };
});

import { buildTmuxSpawnConfig } from './spawnConfig';
import { formatProcessOwnerTag, parseProcessOwnerTag } from '@/processes/ownerTag';
import { parseHappierLinuxScopeName } from '../linux/systemdUserResourceGovernor';

describe('tmux session resource policy', () => {
  beforeEach(() => {
    vi.mocked(getPriority).mockReturnValue(0);
  });
  const originalPlatform = process.platform;
  let commandDirectory: string | null = null;

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    vi.unstubAllEnvs();
    if (commandDirectory) await rm(commandDirectory, { recursive: true, force: true });
    commandDirectory = null;
  });

  async function provisionJobsProbe() {
    commandDirectory = await mkdtemp(join(tmpdir(), 'happier-tmux-resource-policy-'));
    // The executable is the OS boundary; launch/env selection remains real.
    await writeFile(join(commandDirectory, 'systemctl'), [
      '#!/bin/sh',
      'test "$DBUS_SESSION_BUS_ADDRESS" = "unix:path=/test/session-bus" || exit 1',
      'case "$*" in *happier-jobs.slice*) ;; *) exit 1 ;; esac',
      'printf "LoadState=loaded\\nCPUWeight=50\\nIOWeight=50\\nMemoryHigh=1073741824\\n"',
      '',
    ].join('\n'), { mode: 0o700 });
    await writeFile(join(commandDirectory, 'systemd-run'), '#!/bin/sh\n', { mode: 0o700 });
    vi.stubEnv('PATH', `${commandDirectory}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/test/session-bus');
    vi.stubEnv('XDG_RUNTIME_DIR', '/test/runtime');
    vi.stubEnv('HAPPIER_DAEMON_STARTUP_SOURCE', 'background-service');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  }

  it('uses the same provisioned jobs scope and child environment as regular session launches', async () => {
    vi.mocked(getPriority).mockReturnValue(19);
    await provisionJobsProbe();
    const config = await buildTmuxSpawnConfig({
      agent: 'codex',
      sessionId: 'session-123',
      happierHomeDir: '/tmp/happier-tmux-owner-test',
      directory: '/tmp',
      memoryHighBytes: 1048576,
      extraEnv: { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP: '1' },
      unsetEnvKeys: ['happier_process_owner'],
      launchOptions: { runtimeDecision: {
        runtime: 'node',
        argvPrefix: ['--no-warnings', '/test/admitted-runner.mjs'],
        env: { HAPPIER_TEST_RUNNER_ENV: 'retained', HAPPIER_PROCESS_OWNER: 'forged-launch-owner' },
      } },
    });

    expect(config.commandTokens[0]).toBe(join(commandDirectory!, 'systemd-run'));
    expect(config.commandTokens).toEqual(expect.arrayContaining([
      '--collect', expect.stringMatching(/^--unit=happier-session-[0-9a-f]{12}\.session\\x2d123-[0-9a-f]{32}\.scope$/),
    ]));
    expect(config.commandTokens).toEqual(expect.arrayContaining([
      '--slice=happier-jobs.slice', '--nice=19', '/test/admitted-runner.mjs', 'codex',
    ]));
    expect(config.commandTokens).toEqual(expect.arrayContaining(['MemoryAccounting=yes', 'MemoryHigh=1048576']));
    expect(config.tmuxEnv.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/test/session-bus');
    expect(config.tmuxEnv.XDG_RUNTIME_DIR).toBe('/test/runtime');
    expect(config.tmuxEnv.HAPPIER_TEST_RUNNER_ENV).toBe('retained');
    expect(parseProcessOwnerTag(config.tmuxEnv.HAPPIER_PROCESS_OWNER)?.owner).toEqual({ kind: 'session', sessionId: 'session-123' });
    expect(config.unsetEnvKeys).not.toContain('happier_process_owner');
    expect(config.tmuxEnv.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).not.toBe('1');
    expect(config.unsetEnvKeys).toContain('HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP');
    expect(config).toMatchObject({ linuxLaunchUnit: config.commandTokens.find(token => token.startsWith('--unit='))?.slice('--unit='.length) });
  });

  it('gives fresh windows an exact incumbent-daemon scope without inventing a Session owner', async () => {
    await provisionJobsProbe();
    const ownerTag = formatProcessOwnerTag({ happierHomeDir: '/tmp/happier-tmux-incumbent', owner: { kind: 'happier' } });
    vi.stubEnv('HAPPIER_PROCESS_OWNER', ownerTag);
    const config = await buildTmuxSpawnConfig({
      agent: 'codex', directory: '/tmp', extraEnv: { HAPPIER_PROCESS_OWNER: 'forged-owner' },
      unsetEnvKeys: ['happier_process_owner'],
      launchOptions: { runtimeDecision: { runtime: 'node', argvPrefix: ['/test/admitted-runner.mjs'] } },
    });
    const unit = config.commandTokens.find(token => token.startsWith('--unit='))?.slice('--unit='.length);
    expect(unit).toEqual(expect.any(String));
    expect(parseHappierLinuxScopeName(unit!)).toEqual(parseProcessOwnerTag(ownerTag));
    expect(config).toMatchObject({ linuxLaunchUnit: unit });
    expect(config.tmuxEnv.HAPPIER_PROCESS_OWNER).toBe(ownerTag);
    expect(config.unsetEnvKeys).not.toContain('happier_process_owner');
  });

  it('preserves an explicitly unset user bus and uses the existing unsupported-systemd fallback', async () => {
    await provisionJobsProbe();
    const config = await buildTmuxSpawnConfig({
      agent: 'codex', directory: '/tmp', extraEnv: {},
      unsetEnvKeys: ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'],
      launchOptions: { runtimeDecision: {
        runtime: 'node', argvPrefix: ['/test/admitted-runner.mjs'],
      } },
    });
    expect(config.commandTokens[0]).not.toBe('systemd-run');
    expect(config.tmuxEnv.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    expect(config.tmuxEnv.XDG_RUNTIME_DIR).toBeUndefined();
    expect(config.unsetEnvKeys).toEqual(expect.arrayContaining(['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']));
  });
});
