import { existsSync } from 'node:fs';

import { systemTasks } from '@happier-dev/cli-common';
import {
  describeHappierCliOrigin,
  readHappierCliChoiceSync,
  resolveFirstPartyInstallLayout,
  resolveForeignHappierCli,
  resolveHappierCliSearchPath,
  resolveTerminalHappierCli,
  type FirstPartyAcquisitionOptions,
  type HappierCliChoice,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
  ensureLocalFirstPartyComponentCommand,
  resolveExplicitOrInstalledLocalFirstPartyCommand,
  resolveRepoLocalFirstPartyCommandPath,
  resolveLocalHappierCommandTimeoutMs,
  serverHelpSupportsExplicitHomeSetup,
} from '@happier-dev/cli-common/systemTasks';
import type { SetupCliChoicePromptData, SetupCliOrigin } from '@happier-dev/protocol';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { parseFirstJsonObject, runCommandCapture } from './taskRuntime.js';

export function resolveLocalHappierCommand(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  envVarNames?: readonly string[];
}> = {}): string {
  const processEnv = params.processEnv ?? process.env;
  const resolved = resolveExplicitOrInstalledLocalFirstPartyCommand({
    componentId: 'happier-cli',
    processEnv,
    envVarNames: params.envVarNames ?? DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
  });
  if (resolved) return resolved.command;

  return 'happier';
}

export async function runLocalHappierJsonCommand(params: FirstPartyAcquisitionOptions & Readonly<{
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
  allowJsonFailure?: boolean;
  releaseRing?: PublicReleaseRingId;
  stdinText?: string;
  onCommandReady?: () => void;
}>): Promise<unknown> {
  const processEnv = params.processEnv ?? process.env;
  const command = await ensureLocalFirstPartyComponentCommand({
    componentId: 'happier-cli',
    processEnv,
    envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
    releaseRing: params.releaseRing,
    signal: params.signal,
    onProgress: params.onProgress,
  });

  params.signal?.throwIfAborted();
  params.onCommandReady?.();
  const result = await runCommandCapture({
    command,
    args: params.args,
    env: processEnv,
    stdinText: params.stdinText,
    signal: params.signal,
    timeoutMs: resolveLocalHappierCommandTimeoutMs(params.args),
  }).catch((error: unknown) => {
    params.signal?.throwIfAborted();
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Failed to spawn Happier CLI.';
    throw new systemTasks.SystemTaskExecutionError('cli_spawn_failed', message);
  });

  const parsed = parseFirstJsonObject(result.stdout);
  const reportedFailure = readServiceManagerFailure(parsed);

  if (result.status !== 0) {
    if (params.allowJsonFailure && parsed && typeof parsed === 'object') {
      return parsed;
    }
    if (reportedFailure) {
      throw new systemTasks.SystemTaskExecutionError(reportedFailure.code, reportedFailure.message);
    }
    throw new systemTasks.SystemTaskExecutionError(
      'cli_command_failed',
      result.stderr.trim() || result.stdout.trim() || `Command failed: ${command}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new systemTasks.SystemTaskExecutionError(
      'invalid_cli_response',
      `Command did not return a JSON object: ${params.args.join(' ')}`,
    );
  }

  if (!params.allowJsonFailure && isJsonFailureEnvelope(parsed)) {
    if (reportedFailure) {
      throw new systemTasks.SystemTaskExecutionError(reportedFailure.code, reportedFailure.message);
    }
    const envelope = parsed as {
      error?: { code?: unknown; message?: unknown } | unknown;
      message?: unknown;
    };
    const message = typeof envelope.message === 'string' && envelope.message.trim()
      ? envelope.message.trim()
      : envelope.error && typeof envelope.error === 'object' && envelope.error !== null
          && typeof (envelope.error as { message?: unknown }).message === 'string'
        ? ((envelope.error as { message?: string }).message ?? '').trim()
        : `Command failed: ${params.args.join(' ')}`;
    throw new systemTasks.SystemTaskExecutionError('cli_command_failed', message);
  }

  return parsed;
}

/** Preserve the CLI's explicit manager prerequisite failure, without classifying raw output. */
function readServiceManagerFailure(value: unknown) {
  if (!isJsonFailureEnvelope(value)) return null;
  const envelope = value as { error?: unknown; message?: unknown };
  const error = envelope.error;
  const detail = typeof error === 'object' && error !== null
    ? error as { code?: unknown; message?: unknown }
    : null;
  const code = typeof error === 'string' ? error : detail?.code;
  if (code !== 'service_manager_unavailable') return null;
  const message = typeof envelope.message === 'string' ? envelope.message : detail?.message;
  return {
    code,
    message: typeof message === 'string' && message.trim()
      ? message.trim()
      : 'The background service manager is not available on this computer.',
  };
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}

/**
 * The environment a Happier CLI this app did not install runs with: the caller's, with PATH set to
 * the one it was found on (`resolveHappierCliSearchPath`). On macOS a Dock-launched app has
 * launchd's PATH, so an npm `happier` whose `#!/usr/bin/env node` needs Homebrew's `node` would
 * otherwise fail to start (R12). Elsewhere the environment is passed through untouched.
 */
export function resolveLocalHappierCliEnv(processEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.platform === 'darwin' ? { ...processEnv, PATH: resolveHappierCliSearchPath(processEnv) } : processEnv;
}

/** What `<command> --version` answers; `null` when it answers nothing readable. Read-only. */
export async function readLocalHappierCliVersion(params: Readonly<{ command: string; processEnv: NodeJS.ProcessEnv }>): Promise<string | null> {
  const result = await runCommandCapture({ command: params.command, args: ['--version'], env: resolveLocalHappierCliEnv(params.processEnv) })
    .catch(() => null);
  const version = result?.status === 0
    ? result.stdout.trim().split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? ''
    : '';
  return /^v?\d+\.\d+\.\d+/u.test(version) ? version : null;
}

/**
 * Whether `<command>` can drive desktop setup — the 0.3 setup floor. 0.3 has no version floor: the
 * CLI's own `server help` proves the one capability explicit-Home setup cannot do without
 * (`server set --no-use`), through the same test the setup executor applies before its first write.
 */
export async function readLocalHappierCliSetupCapable(params: Readonly<{ command: string; processEnv: NodeJS.ProcessEnv }>): Promise<boolean> {
  const help = await runCommandCapture({ command: params.command, args: ['server', 'help'], env: resolveLocalHappierCliEnv(params.processEnv) })
    .catch(() => null);
  return help !== null && serverHelpSupportsExplicitHomeSetup(help);
}

function resolveManagedCliShimDir(processEnv: NodeJS.ProcessEnv): string {
  return resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv }).shimDir;
}

/** A developer override (env path or a repo checkout) names the CLI: R12 never asks about it. */
function isDevelopmentCliOverride(processEnv: NodeJS.ProcessEnv): boolean {
  return DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES.some((name) => String(processEnv[name] ?? '').trim())
    || resolveRepoLocalFirstPartyCommandPath({ componentId: 'happier-cli', processEnv }) !== null;
}

/** A `happier` this app did not install, named with the commands that remove or update it (R12). */
export type LocalOtherHappierCli = Readonly<{
  command: string;
  origin: SetupCliOrigin;
  removalCommand: string | null;
  updateCommand: string | null;
}>;

/**
 * R12 — this computer's CLI choice as the app shows it: `mode` is the recorded answer (`null`:
 * nobody was asked), and `otherCli` the CLI that is not the managed one — the kept CLI after "Keep
 * my own", otherwise a `happier` still on the search path (the old copy after "Let Happier manage
 * it"). A kept CLI that disappeared stays the answer (R13 b); a `happier` installed since elsewhere
 * is then the one there is to choose, and with none the kept path is still named. Spawns nothing.
 */
export type LocalHappierCliChoiceFacts = Readonly<{
  mode: HappierCliChoice['mode'] | null;
  otherCli: LocalOtherHappierCli | null;
}>;

export function readLocalHappierCliChoiceFacts(processEnv: NodeJS.ProcessEnv = process.env): LocalHappierCliChoiceFacts {
  const choice = readHappierCliChoiceSync({ processEnv });
  const keptCommand = choice?.mode === 'own' ? choice.command : null;
  const command = keptCommand && existsSync(keptCommand)
    ? keptCommand
    : resolveForeignHappierCli({ binDir: resolveManagedCliShimDir(processEnv), processEnv }) ?? keptCommand;
  if (!command) {
    return { mode: choice?.mode ?? null, otherCli: null };
  }
  const origin = describeHappierCliOrigin(command);
  return {
    mode: choice?.mode ?? null,
    otherCli: { command, origin: origin.kind, removalCommand: origin.removalCommand, updateCommand: origin.updateCommand },
  };
}

export type LocalHappierCliChoiceInspection = Readonly<{
  /** What this computer recorded, including a kept CLI that has since disappeared. */
  choice: HappierCliChoice | null;
  /** The one question to ask before setup writes anything, or `null` when there is none. */
  question: SetupCliChoicePromptData | null;
}>;

/**
 * R12 — whether setup must ask "Let Happier manage it / Keep my own" before it writes anything,
 * and about which CLI. Read-only: it runs only that CLI's `--version` and `server help`.
 *
 * Asked when the `happier` a new terminal runs first is one this app did not install and nobody
 * answered yet (a copy behind the managed CLI is Settings' to name, RV3-1), when the kept CLI
 * cannot serve setup (keeping it cannot finish setup), and when the kept CLI disappeared (R13 b).
 * `reconsider` is Settings' change action. A developer override is never asked about, and a
 * computer with no other CLI keeps the managed default with no question.
 */
export async function inspectLocalHappierCliChoice(
  params: Readonly<{ processEnv?: NodeJS.ProcessEnv; reconsider?: boolean }>,
  overrides: Readonly<{
    readVersion?: typeof readLocalHappierCliVersion;
    readSetupCapable?: typeof readLocalHappierCliSetupCapable;
  }> = {},
): Promise<LocalHappierCliChoiceInspection> {
  const processEnv = params.processEnv ?? process.env;
  const readVersion = overrides.readVersion ?? readLocalHappierCliVersion;
  const readSetupCapable = overrides.readSetupCapable ?? readLocalHappierCliSetupCapable;
  const choice = readHappierCliChoiceSync({ processEnv });
  if (isDevelopmentCliOverride(processEnv)) {
    return { choice, question: null };
  }

  const other = readLocalHappierCliChoiceFacts(processEnv).otherCli;
  if (!other || (choice?.mode === 'managed' && !params.reconsider)) {
    return { choice, question: null };
  }
  const terminal = resolveTerminalHappierCli({ binDir: resolveManagedCliShimDir(processEnv), processEnv });
  if (choice === null && !params.reconsider && !(terminal && !terminal.managed)) {
    return { choice, question: null };
  }
  // Keeping `other` makes the terminal run it only when what answers first is `other` itself or a
  // managed CLI Desktop exposed (and "Keep my own" takes back). The installer's link keeps answering.
  const keepBlockedBy = terminal?.managed && !terminal.desktopExposed ? terminal.command : null;
  const missing = !existsSync(other.command);
  const version = missing ? null : await readVersion({ command: other.command, processEnv }).catch(() => null);
  // A CLI that cannot report its version cannot drive setup either.
  const belowSetupFloor = version === null
    || !(await readSetupCapable({ command: other.command, processEnv }).catch(() => false));
  const keptAndUsable = choice?.mode === 'own' && choice.command === other.command && !missing && !belowSetupFloor;
  if (keptAndUsable && !params.reconsider) {
    return { choice, question: null };
  }
  return { choice, question: { ...other, version, belowSetupFloor, missing, keepBlockedBy } };
}

/** `cli_own_below_setup_floor`, naming the update command that CLI's origin proves (R12). */
export function ownCliCannotServeSetupError(
  command: string,
  version: string | null,
  knownUpdateCommand?: string | null,
): systemTasks.SystemTaskExecutionError {
  const updateCommand = knownUpdateCommand ?? describeHappierCliOrigin(command).updateCommand;
  const found = version
    ? `Your Happier CLI at ${command} (version ${version}) is too old for desktop setup.`
    : `Your Happier CLI at ${command} did not report a version, so desktop setup cannot use it.`;
  return new systemTasks.SystemTaskExecutionError(
    'cli_own_below_setup_floor',
    updateCommand ? `${found} Update it with: ${updateCommand}` : `${found} Update it where you installed it.`,
  );
}

/**
 * R12 — the app-open read failed on the CLI the one-CLI question is about: a `happier` nobody has
 * answered for yet, or the one the person kept. Retrying cannot change that, so the failure is named
 * `cli_choice_required` and the app routes it into setup, whose first step asks the question.
 * `null` for any other failure, a cancelled read, a developer override, or a recorded "manage".
 */
export function describeUnservedCliChoiceFailure(
  error: unknown,
  params: Readonly<{ releaseRing?: PublicReleaseRingId; processEnv?: NodeJS.ProcessEnv }> = {},
): systemTasks.SystemTaskExecutionError | null {
  const processEnv = params.processEnv ?? process.env;
  if (!(error instanceof systemTasks.SystemTaskExecutionError) || error.code === 'cancelled') {
    return null;
  }
  if (error.code === 'cli_choice_required') {
    // Already named — the resolver's answer for a kept CLI that disappeared (R13 b).
    return error;
  }
  if (isDevelopmentCliOverride(processEnv)) {
    return null;
  }
  const facts = readLocalHappierCliChoiceFacts(processEnv);
  const other = facts.mode === 'managed' ? null : facts.otherCli;
  let answering: string | null = null;
  try {
    answering = resolveExplicitOrInstalledLocalFirstPartyCommand({
      componentId: 'happier-cli',
      processEnv,
      envVarNames: DEFAULT_HAPPIER_CLI_ENV_VAR_NAMES,
      ...(params.releaseRing ? { releaseRing: params.releaseRing } : {}),
    })?.command ?? null;
  } catch {
    answering = null;
  }
  if (!other || answering !== other.command) {
    return null;
  }
  return new systemTasks.SystemTaskExecutionError(
    'cli_choice_required',
    `The Happier CLI at ${other.command} could not answer (${error.code}): ${error.message}`,
  );
}
