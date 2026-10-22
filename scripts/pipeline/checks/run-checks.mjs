// @ts-check

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { resolveChecksProfilePlan } from './lib/checks-profile.mjs';
import { runCommandSuite } from '../../testing/lib/runCommandSuite.ts';
import { execPnpm, resolvePnpmInvocation } from '../../workspaces/execPnpmCommand.mjs';
import { execFileSyncPortable } from '../lib/exec-file-sync-portable.mjs';

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function parseBoolString(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be 'true' or 'false' (got: ${value})`);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} defaultValue
 */
function resolveBoolEnv(value, name, defaultValue) {
  const raw = String(value ?? '').trim();
  if (!raw) return defaultValue;
  return parseBoolString(raw, name);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {boolean} autoValue
 */
function resolveAutoBool(value, name, autoValue) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return autoValue;
  return parseBoolString(raw, name);
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [extra]
 */
function run(opts, cmd, args, extra) {
  const printable = `${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }
  execFileSyncPortable(cmd, args, {
    env: { ...process.env, ...(extra?.env ?? {}) },
    stdio: 'inherit',
    timeout: 4 * 60 * 60_000,
  });
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [extra]
 */
function runReleaseValidate(opts, args, extra) {
  const commandArgs = ['scripts/pipeline/run.mjs', 'release-validate', ...args];
  const env = { ...process.env, ...(extra?.env ?? {}) };
  if (opts.dryRun) {
    run({ dryRun: true }, process.execPath, commandArgs);
    const output = execFileSync(process.execPath, [...commandArgs, '--dry-run'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 4 * 60 * 60_000,
    });
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return;
  }
  run(opts, process.execPath, commandArgs, { env });
}

/**
 * @param {{ dryRun: boolean }} opts
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [extra]
 */
function runPnpm(opts, args, extra) {
  if (opts.dryRun) {
    const invocation = resolvePnpmInvocation();
    run(opts, invocation.command, [...invocation.args, ...args], extra);
    return;
  }
  execPnpm(args, {
    env: { ...process.env, ...(extra?.env ?? {}) },
    stdio: 'inherit',
    timeout: 4 * 60 * 60_000,
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      'custom-checks': { type: 'string', default: '' },
      'install-deps': { type: 'string', default: 'auto' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  const profile = String(values.profile ?? '').trim();
  if (!profile) fail('--profile is required (full|fast|none|custom|release-assets)');
  const customChecks = String(values['custom-checks'] ?? '').trim();

  const plan = resolveChecksProfilePlan({
    profile,
    customChecks,
  });

  const dryRun = values['dry-run'] === true;
  const installDeps = resolveAutoBool(values['install-deps'], '--install-deps', process.env.GITHUB_ACTIONS === 'true');

  console.log(`[pipeline] checks: profile=${profile}`);
  console.log('[pipeline] checks: plan');
  for (const [k, v] of Object.entries(plan)) {
    console.log(`- ${k}: ${v}`);
  }

  if (!plan.runCi) {
    console.log('[pipeline] checks: skipped (profile=none)');
    return;
  }

  if (installDeps) {
    run({ dryRun }, process.execPath, ['scripts/ci/setup-pnpm.mjs']);
    runPnpm({ dryRun }, ['install', '--frozen-lockfile', '--prod=false'], {
      env: { NODE_ENV: 'development', pnpm_config_production: 'false', npm_config_production: 'false' },
    });
  }

  /** @type {Array<{ id: string; args: string[]; execute: () => void }>} */
  const commands = [];
  /** @param {string} id @param {() => void} execute */
  const check = (id, execute) => commands.push({ id, args: [], execute });

  if (plan.runUnit) check('unit', () => runPnpm({ dryRun }, ['run', 'test']));
  if (plan.runIntegration) check('integration', () => runPnpm({ dryRun }, ['run', 'test:integration']));
  if (plan.runTypecheck) check('typecheck', () => runPnpm({ dryRun }, ['run', 'typecheck']));
  if (plan.runUiE2e) check('ui_e2e', () => runPnpm({ dryRun }, ['run', 'test:e2e:ui']));
  if (plan.runReleaseContracts) {
    check('release_contracts', () => runPnpm({ dryRun }, ['run', '--silent', 'test:release:contracts'], { env: { HAPPIER_FEATURE_POLICY_ENV: '' } }));
    check('release_sync_installers', () => run({ dryRun }, process.execPath, ['scripts/pipeline/run.mjs', 'release-sync-installers', '--check']));
  }
  if (plan.runE2eCore) check('e2e_core', () => runPnpm({ dryRun }, ['run', 'test:e2e:core:fast']));
  if (plan.runE2eCoreSlow) check('e2e_core_slow', () => runPnpm({ dryRun }, ['run', 'test:e2e:core:slow']));
  if (plan.runServerDbContract) check('server_db_contract', () => runPnpm({ dryRun }, ['run', 'test:db-contract:docker']));
  if (plan.runStress) check('stress', () => runPnpm({ dryRun }, ['run', 'test:stress']));
  if (plan.runBuildWebsite) check('build_website', () => runPnpm({ dryRun }, ['run', 'website:build']));
  if (plan.runBuildDocs) check('build_docs', () => runPnpm({ dryRun }, ['run', 'docs:build']));
  if (plan.runCliSmokeLinux) check('cli_smoke_linux', () => run({ dryRun }, process.execPath, ['scripts/pipeline/run.mjs', 'smoke-cli']));

  if (plan.runReleaseAssetsE2e) check('release_assets_e2e', () => {
    const modeRaw = String(process.env.HAPPIER_RELEASE_ASSETS_E2E_MODE ?? '').trim().toLowerCase();
    const mode = modeRaw === 'npm' || modeRaw === 'local' ? modeRaw : modeRaw ? null : 'local';
    if (!mode) {
      fail(`HAPPIER_RELEASE_ASSETS_E2E_MODE must be 'npm' or 'local' (got: ${modeRaw || '<empty>'})`);
    }

    const monorepoRaw = String(process.env.HAPPIER_RELEASE_ASSETS_E2E_MONOREPO ?? '').trim().toLowerCase();
    const monorepoDefault = mode === 'local' ? 'local' : 'github';
    const monorepo =
      monorepoRaw === 'github' || monorepoRaw === 'local' ? monorepoRaw : monorepoRaw ? null : monorepoDefault;
    if (!monorepo) {
      fail(`HAPPIER_RELEASE_ASSETS_E2E_MONOREPO must be 'github' or 'local' (got: ${monorepoRaw || '<empty>'})`);
    }

    if (monorepo !== monorepoDefault) {
      fail(
        `docker-release-assets derives monorepo=${monorepoDefault} from mode=${mode}; `
        + `HAPPIER_RELEASE_ASSETS_E2E_MONOREPO=${monorepo} is not supported`,
      );
    }

    const withRelayUpgrade = resolveBoolEnv(
      process.env.HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE,
      'HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE',
      mode === 'local',
    );
    const expectedRelayUpgrade = mode === 'local';
    if (withRelayUpgrade !== expectedRelayUpgrade) {
      fail(
        `docker-release-assets derives relay upgrade=${expectedRelayUpgrade} from mode=${mode}; `
        + `HAPPIER_RELEASE_ASSETS_E2E_WITH_RELAY_UPGRADE=${withRelayUpgrade} is not supported`,
      );
    }

    const sourceArgs = mode === 'local'
      ? ['--source', 'local-build', '--ref', '.']
      : ['--source', 'published-channel', '--ref', 'preview'];

    runReleaseValidate(
      { dryRun },
      [
        '--suite',
        'docker-release-assets',
        '--platform',
        'linux',
        ...sourceArgs,
      ],
      {},
    );
  });

  if (plan.runSelfHostSystemd) check('self_host_systemd', () => {
    if (!dryRun) {
      if (process.platform !== 'linux') fail(`self_host_systemd is linux-only (current: ${process.platform})`);
      if (process.arch !== 'x64') fail(`self_host_systemd requires linux-x64 (current: ${process.platform}-${process.arch})`);
      if (!commandExists('systemctl')) fail('self_host_systemd requires systemctl');
      if (!commandExists('bun')) fail('self_host_systemd requires bun (needed to build compiled binaries)');
      if (typeof process.getuid === 'function' && process.getuid() !== 0 && !commandExists('sudo')) {
        fail('self_host_systemd requires sudo/root access');
      }
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_systemd.real.integration.test.mjs']);
  });

  if (plan.runSelfHostLaunchd) check('self_host_launchd', () => {
    if (!dryRun) {
      if (process.platform !== 'darwin') fail(`self_host_launchd is macOS-only (current: ${process.platform})`);
      if (!commandExists('launchctl')) fail('self_host_launchd requires launchctl');
      if (!commandExists('bun')) fail('self_host_launchd requires bun (needed to build compiled binaries)');
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_launchd.real.integration.test.mjs']);
  });

  if (plan.runSelfHostSchtasks) check('self_host_schtasks', () => {
    if (!dryRun) {
      if (process.platform !== 'win32') fail(`self_host_schtasks is Windows-only (current: ${process.platform})`);
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_schtasks.real.integration.test.mjs']);
  });

  if (plan.runSelfHostDaemon) check('self_host_daemon', () => {
    if (!dryRun) {
      if (process.platform !== 'linux' && process.platform !== 'darwin') {
        fail(`self_host_daemon supports linux and macOS only (current: ${process.platform})`);
      }
      if (!commandExists('bun')) fail('self_host_daemon requires bun (needed to build compiled binaries)');
      if (process.platform === 'linux') {
        if (!commandExists('systemctl')) fail('self_host_daemon requires systemctl on linux');
        if (typeof process.getuid === 'function' && process.getuid() !== 0 && !commandExists('sudo')) {
          fail('self_host_daemon requires sudo/root access on linux');
        }
      }
    }
    run({ dryRun }, process.execPath, ['--test', 'apps/stack/scripts/self_host_daemon.real.integration.test.mjs']);
  });
  await runCommandSuite({
    commands,
    runCommand: async (command) => command.execute(),
    suiteName: 'Local checks',
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
