// @ts-check

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';

/**
 * Runs the `tauri:prepare:*` script through the repository package-manager owner.
 *
 * @param {{
 *   mode: 'dev' | 'build';
 *   platform?: NodeJS.Platform;
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   execFileSync?: typeof execFileSync;
 * }} opts
 */
export function runTauriBeforeCommand(opts) {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const execImpl = opts.execFileSync ?? execFileSync;

  const mode = opts.mode;
  if (mode !== 'dev' && mode !== 'build') {
    throw new Error(`mode must be 'dev' or 'build' (got: ${String(mode)})`);
  }

  const invocation = resolvePnpmCommandInvocation(['--silent', 'run', `tauri:prepare:${mode}`], {
    platform,
    npmExecPath: String(env.npm_execpath ?? ''),
    comspec: env.COMSPEC ?? env.ComSpec ?? env.comspec,
  });
  execImpl(invocation.command, invocation.args, {
    cwd, env, stdio: 'inherit',
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

function main() {
  const raw = String(process.argv[2] ?? '').trim();
  const mode =
    raw === 'dev' || raw === 'build'
      ? raw
      : raw === 'tauri:prepare:dev'
        ? 'dev'
        : raw === 'tauri:prepare:build'
          ? 'build'
          : '';

  if (mode !== 'dev' && mode !== 'build') {
    console.error('Usage: node ./scripts/runTauriBeforeCommand.mjs <dev|build|tauri:prepare:dev|tauri:prepare:build>');
    process.exit(1);
  }

  runTauriBeforeCommand({ mode });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
