import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStdout } from '@/testkit/logger/captureOutput';
import { createEnvKeyScope } from '@/testkit/env/envScope';

// Scheduled Task enumeration is a Windows OS boundary, unavailable on this
// Linux-hosted platform simulation. No installed service needs preserving.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => (
    args[0] === 'powershell.exe'
      ? { pid: 123, output: [], stdout: '[]', stderr: '', status: 0, signal: null }
      : actual.spawnSync(...args)
  ) };
});

/**
 * `self update` runs the one CLI update transaction (`runManagedCliUpdate`, plan R13 f) for real
 * against a temporary Happier home. Only system boundaries are replaced: the GitHub release lookup
 * and download (`resolveFirstPartyComponentRelease` / `prepareFirstPartyComponentPayloadFromGitHubRelease`),
 * the Windows payload-process quiesce (process kill), and the post-update migration/doctor steps.
 * The staged CLI is a real executable whose `--version` is the smoke the transaction runs.
 */
const {
  maybeRunDoctorRepairMock,
  maybeRunVersionGatedRuntimeMigrationMock,
  quiesceInstalledCliWindowsPayloadOwnersMock,
  releaseState,
} = vi.hoisted(() => ({
  maybeRunDoctorRepairMock: vi.fn<(params: unknown) => Promise<boolean>>(async () => false),
  maybeRunVersionGatedRuntimeMigrationMock: vi.fn<(params: unknown) => Promise<boolean>>(async () => false),
  quiesceInstalledCliWindowsPayloadOwnersMock: vi.fn<(params: unknown) => Promise<void>>(async () => undefined),
  releaseState: {
    version: '9.9.10',
    /** What the staged executable prints for `--version` (defaults to `version`). */
    reports: null as string | null,
    scratchDir: '',
    prepared: [] as Array<Readonly<{ channel: string; versionId?: string }>>,
  },
}));

function writeExecutable(path: string, printedVersion: string): void {
  writeFileSync(path, `#!/bin/sh\necho ${printedVersion}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function createPayload(version: string, printedVersion = version): string {
  const payloadRoot = mkdtempSync(join(releaseState.scratchDir, `payload-${version}-`));
  mkdirSync(join(payloadRoot, 'package-dist'), { recursive: true });
  writeExecutable(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), printedVersion);
  writeFileSync(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n', 'utf8');
  return payloadRoot;
}

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    resolveFirstPartyComponentRelease: vi.fn(async () => ({ versionId: releaseState.version })),
    prepareFirstPartyComponentPayloadFromGitHubRelease: vi.fn(async (params: Readonly<{ channel: string; versionId?: string }>) => {
      releaseState.prepared.push({ channel: params.channel, ...(params.versionId ? { versionId: params.versionId } : {}) });
      const version = params.versionId ?? releaseState.version;
      const payloadRoot = createPayload(version, releaseState.reports ?? version);
      return {
        componentId: 'happier-cli',
        channel: params.channel,
        versionId: version,
        payloadRoot,
        source: null,
        cleanup: async () => { rmSync(payloadRoot, { recursive: true, force: true }); },
      };
    }),
  };
});

vi.mock('./self/maybeRunVersionGatedRuntimeMigration', () => ({
  maybeRunVersionGatedRuntimeMigration: (params: unknown) => maybeRunVersionGatedRuntimeMigrationMock(params),
}));

vi.mock('./self/maybeRunDoctorRepair', () => ({
  maybeRunDoctorRepair: (params: unknown) => maybeRunDoctorRepairMock(params),
}));

vi.mock('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners')>(),
  quiesceInstalledCliWindowsPayloadOwners: (params: unknown) => quiesceInstalledCliWindowsPayloadOwnersMock(params),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function runSelf(params: Readonly<{ invokedPath: string; rawArgv: string[] }>): Promise<Readonly<{ logs: string; errors: string; exitCode: number | null }>> {
  const originalArgv = [...process.argv];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = Number(code ?? 0);
    throw new Error(`process.exit(${exitCode})`);
  }) as typeof process.exit);
  try {
    // Runtime assets are loaded from this source checkout before the test
    // substitutes the installed invocation identity used by discovery.
    const { handleSelfCliCommand } = await import('./self');
    process.argv[1] = params.invokedPath;
    await handleSelfCliCommand({
      args: params.rawArgv.slice(1),
      rawArgv: params.rawArgv,
      terminalRuntime: null,
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith('process.exit(')) throw error;
    });
    return { logs: logSpy.mock.calls.flat().join('\n'), errors: errorSpy.mock.calls.flat().join('\n'), exitCode };
  } finally {
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
}

describe.skipIf(process.platform === 'win32')('happier self update for binary installs', { timeout: 300_000 }, () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
    'HAPPIER_RELEASE_RING',
    'HAPPIER_RELEASE_CHANNEL',
    'HAPPIER_CLI_UPDATE_CHECK',
  ]);
  let homeDir = '';

  async function installInitial(version: string, channel: 'stable' | 'publicdev' = 'stable'): Promise<void> {
    const { installVersionedPayload } = await import('@happier-dev/cli-common/firstPartyRuntime');
    await installVersionedPayload({
      componentId: 'happier-cli',
      channel,
      versionId: version,
      payloadRoot: createPayload(version),
      processEnv: { ...process.env, HAPPIER_HOME_DIR: homeDir },
    });
  }

  async function currentVersion(channel: 'stable' | 'publicdev' = 'stable'): Promise<string | null> {
    const { readInstalledVersionMarkersSync, resolveFirstPartyInstallLayout } = await import('@happier-dev/cli-common/firstPartyRuntime');
    return readInstalledVersionMarkersSync(resolveFirstPartyInstallLayout({
      componentId: 'happier-cli',
      releaseRing: channel,
      processEnv: { HAPPIER_HOME_DIR: homeDir },
    })).currentVersionId;
  }

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'happier-self-update-'));
    releaseState.scratchDir = mkdtempSync(join(tmpdir(), 'happier-self-update-release-'));
    releaseState.version = '9.9.10';
    releaseState.reports = null;
    releaseState.prepared = [];
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
      HAPPIER_RELEASE_RING: undefined,
      HAPPIER_RELEASE_CHANNEL: undefined,
      HAPPIER_CLI_UPDATE_CHECK: '0',
    });
    // Load physical source assets before a case simulates a compiled binary's
    // execPath/platform. Discovery still observes that simulated invocation.
    await import('./self');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    maybeRunDoctorRepairMock.mockClear();
    maybeRunVersionGatedRuntimeMigrationMock.mockClear();
    quiesceInstalledCliWindowsPayloadOwnersMock.mockClear();
    envScope.restore();
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(releaseState.scratchDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('updates through the one transaction and records the outcome', async () => {
    await installInitial('9.9.9');
    const stdout = captureStdout();
    let result: Awaited<ReturnType<typeof runSelf>>;
    try {
      result = await runSelf({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });
      expect(stdout.text()).toContain('Downloading, verifying and installing');
    } finally {
      stdout.restore();
    }

    expect(result.exitCode, result.errors).toBeNull();
    expect(result.logs).toContain('Updated happier to 9.9.10');
    expect(await currentVersion()).toBe('9.9.10');
    expect(releaseState.prepared).toEqual([{ channel: 'stable' }]);
    const lastUpdate = JSON.parse(readFileSync(join(homeDir, 'cli', 'last-update.json'), 'utf8'));
    expect(lastUpdate).toMatchObject({ targetVersion: '9.9.10', outcome: 'succeeded' });
    expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith(expect.objectContaining({
      fromVersion: '9.9.9',
      toVersion: '9.9.10',
    }));
    // No service daemon was running before the update: nothing is restarted.
    expect(result.logs).not.toContain('background service now runs');
  });

  it('updates a Windows install through the cross-platform acquisition, stopping payload processes before activation (S-5)', async () => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    await installInitial('9.9.9');
    const result = await runSelf({ invokedPath: 'C:\\Users\\me\\.happier\\bin\\happier.exe', rawArgv: ['happier', 'self', 'update'] });

    expect(result.errors).not.toContain('Unsupported platform');
    expect(result.exitCode, result.errors).toBeNull();
    expect(releaseState.prepared).toEqual([{ channel: 'stable' }]);
    expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith(expect.objectContaining({ channel: 'stable' }));
    expect(await currentVersion()).toBe('9.9.10');
  });

  it('reports its admission on the pipe a daemon that started it waits on', async () => {
    const { UPDATER_ADMISSION_FD_ENV } = await import('@/cli/runtime/update/updaterAdmission');
    await installInitial('9.9.9');
    const reportPath = join(homeDir, 'admission');
    process.env[UPDATER_ADMISSION_FD_ENV] = String(openSync(reportPath, 'w'));
    const result = await runSelf({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });
    expect(result.exitCode).toBeNull();
    expect(readFileSync(reportPath, 'utf8')).toBe('{"admitted":true}\n');
    expect(process.env[UPDATER_ADMISSION_FD_ENV]).toBeUndefined();
  });

  it('activates nothing and exits 1 when the downloaded CLI does not run (staged smoke)', async () => {
    await installInitial('9.9.9');
    releaseState.reports = '1.0.0';
    const result = await runSelf({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain('did not start on this machine');
    expect(await currentVersion()).toBe('9.9.9');
    expect(maybeRunVersionGatedRuntimeMigrationMock).not.toHaveBeenCalled();
  });

  it('refuses a stable update when the resolved payload belongs to preview', async () => {
    await installInitial('9.9.9');
    releaseState.version = '9.9.10-preview.3';
    const result = await runSelf({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });

    expect(result.exitCode).toBe(1);
    expect(result.errors).toContain('does not match the stable release channel');
    expect(await currentVersion()).toBe('9.9.9');
  });

  it('binds an exact --to version and routes hdev to the publicdev ring', async () => {
    await installInitial('9.9.9-dev.1', 'publicdev');
    const result = await runSelf({ invokedPath: '/opt/happier/bin/hdev', rawArgv: ['hdev', 'self', 'update', '--to', 'v9.9.10-dev.2'] });

    expect(result.exitCode).toBeNull();
    expect(releaseState.prepared).toEqual([{ channel: 'publicdev', versionId: '9.9.10-dev.2' }]);
    expect(result.logs).toContain('Updated hdev to 9.9.10-dev.2');
  });

  it('does not mark a stable self check as updateable from a preview binary candidate', async () => {
    releaseState.version = '9.9.10-preview.3';
    await runSelf({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'check', '--quiet'] });

    const cache = JSON.parse(readFileSync(join(homeDir, 'cache', 'update.json'), 'utf8'));
    expect(cache.latest).toBeNull();
    expect(cache.updateAvailable).toBe(false);
  });

  it('leaves a Homebrew install to Homebrew and names its update command', async () => {
    const result = await runSelf({
      invokedPath: '/opt/homebrew/Cellar/happier/0.3.1/bin/happier',
      rawArgv: ['happier', 'self', 'update'],
    });
    expect(releaseState.prepared).toEqual([]);
    expect(result.logs).toContain('brew upgrade happier');
  });

  it('recognises the Homebrew keg from the compiled binary path when argv only names the embedded bundle', async () => {
    // A Bun-compiled `happier` reports `argv[1]` as `/$bunfs/root/happier`; only `execPath` (the
    // resolved executable) says where the payload was installed.
    const originalExecPath = process.execPath;
    Object.defineProperty(process, 'execPath', {
      value: '/opt/homebrew/Cellar/happier/0.3.1/libexec/happier',
      configurable: true,
      writable: true,
    });
    try {
      const result = await runSelf({ invokedPath: '/$bunfs/root/happier', rawArgv: ['happier', 'self', 'update'] });
      expect(releaseState.prepared).toEqual([]);
      expect(result.logs).toContain('brew upgrade happier');
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true, writable: true });
    }
  });

  it('reports admission — or the refusal — to the daemon that started it on the admission pipe', async () => {
    const { UPDATER_ADMISSION_FD_ENV } = await import('@/cli/runtime/update/updaterAdmission');
    await installInitial('9.9.9');
    const reportPath = join(homeDir, 'admission');

    process.env[UPDATER_ADMISSION_FD_ENV] = String(openSync(reportPath, 'w'));
    expect((await runSelf({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] })).exitCode).toBeNull();
    expect(readFileSync(reportPath, 'utf8')).toBe('{"admitted":true}\n');

    process.env[UPDATER_ADMISSION_FD_ENV] = String(openSync(reportPath, 'w'));
    await runSelf({ invokedPath: '/opt/homebrew/Cellar/happier/0.3.1/bin/happier', rawArgv: ['happier', 'self', 'update'] });
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ admitted: false, code: 'cli_not_managed' });
  });
});

