import { execFile } from 'node:child_process';

import { ensureCliDistBuilt } from '../process/cliDist';
import { waitFor } from '../timing';
export {
  readPluginInstallReviewRequiredEnvelope,
  type PluginInstallationReviewFacts,
} from './pluginInstallReviewRequiredEnvelope.mjs';

export type PluginInstallDecisionOutcome = Readonly<{
  kind: 'committed' | 'failed' | 'conflict' | 'expired' | 'cancelled' | 'unavailable' | 'outcomeUnknown' | 'busy';
  pluginId?: string;
  desiredGeneration?: string | null;
  appliedGeneration?: string | null;
  pendingSurfaces?: readonly string[];
  code?: string;
  message?: string;
}>;

export type AuthenticatedPluginInstallReviewTimeoutDiagnostic = Readonly<{
  pendingChangeId: string;
  decidedAtMs: number;
  timedOutAtMs: number;
  lastStatusKind: string | null;
}>;

export class AuthenticatedPluginInstallReviewTimeoutError extends Error {
  readonly code = 'authenticated_plugin_install_review_timeout';

  constructor(
    readonly diagnostic: AuthenticatedPluginInstallReviewTimeoutDiagnostic,
    options?: ErrorOptions,
  ) {
    super(
      `Authenticated plugin install review decision timed out: ${JSON.stringify(diagnostic)}`,
      options,
    );
    this.name = 'AuthenticatedPluginInstallReviewTimeoutError';
  }
}

type CliRunResult = Readonly<{ code: number | null; stdout: string }>;

type AuthenticatedInstallReviewDeps = Readonly<{
  runCli: (params: Readonly<{
    cliEntrypoint: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>) => Promise<CliRunResult>;
  resolveCliEntrypoint: (cliHomeDir: string) => Promise<string>;
  nowMs: () => number;
  settleTimeoutMs: number;
}>;

const INSTALL_SETTLE_TIMEOUT_MS = 5 * 60_000;

const defaultDeps: AuthenticatedInstallReviewDeps = {
  runCli: ({ cliEntrypoint, args, env }) => new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliEntrypoint, ...args],
      { env, maxBuffer: 32 * 1024 * 1024, timeout: 120_000 },
      (error, stdout) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error ? null : 0;
        if (error && !stdout.trim()) reject(error);
        else resolve({ code, stdout });
      },
    );
  }),
  resolveCliEntrypoint: async (cliHomeDir) => await ensureCliDistBuilt(
    { testDir: cliHomeDir, env: process.env },
  ),
  nowMs: Date.now,
  settleTimeoutMs: INSTALL_SETTLE_TIMEOUT_MS,
};

function readJsonEnvelope(stdout: string, context: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // fall through to the typed failure below
  }
  throw new Error(`Authenticated plugin install review ${context} did not return a JSON envelope`);
}

function projectTerminalResult(result: unknown): PluginInstallDecisionOutcome {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Readonly<Record<string, unknown>>
    : null;
  const kind = record?.kind;
  if (
    kind === 'committed' || kind === 'failed' || kind === 'conflict' || kind === 'expired'
    || kind === 'cancelled' || kind === 'unavailable' || kind === 'outcomeUnknown' || kind === 'busy'
  ) {
    return record as PluginInstallDecisionOutcome;
  }
  throw new Error('Authenticated plugin install review returned an invalid terminal outcome');
}

/**
 * Decides the daemon-retained install review as the present user through the
 * canonical `approval.request.decide` Action. The approval Artifact id is the
 * pending change id, and the install settles in the daemon change service,
 * which `plugins change status` reads.
 */
export async function decideAuthenticatedPluginInstallReview(input: Readonly<{
  cliHomeDir: string;
  serverUrl: string;
  pendingChangeId: string;
  /** Optional host access is not expressible in an approval decision; only unselected is accepted. */
  optionalSelections?: readonly Readonly<{ accessId: string; selected: boolean }>[];
  confirmPresentUser: () => Promise<boolean>;
  cliEntrypoint?: string;
  deps?: Partial<AuthenticatedInstallReviewDeps>;
}>): Promise<PluginInstallDecisionOutcome> {
  const deps = { ...defaultDeps, ...(input.deps ?? {}) };
  if ((input.optionalSelections ?? []).some((selection) => selection.selected)) {
    throw new Error('Authenticated plugin install review cannot select optional host access through an approval decision');
  }
  const approve = await input.confirmPresentUser();
  const cliEntrypoint = input.cliEntrypoint ?? await deps.resolveCliEntrypoint(input.cliHomeDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HAPPIER_HOME_DIR: input.cliHomeDir,
    HAPPIER_SERVER_URL: input.serverUrl,
    HAPPIER_WEBAPP_URL: input.serverUrl,
  };
  const decided = await deps.runCli({
    cliEntrypoint,
    env,
    args: [
      'actions', 'invoke', 'approval.request.decide',
      '--input-json', JSON.stringify({
        artifactId: input.pendingChangeId,
        decision: approve ? 'approve' : 'cancel',
      }),
      '--json',
    ],
  });
  const decidedEnvelope = readJsonEnvelope(decided.stdout, 'decision');
  if (decided.code !== 0 || decidedEnvelope.ok !== true) {
    const error = decidedEnvelope.error as Readonly<Record<string, unknown>> | undefined;
    throw new Error(
      `Authenticated plugin install review failed: ${String(error?.code ?? decidedEnvelope.errorCode ?? 'unknown-error')}`,
    );
  }
  if (!approve) return { kind: 'cancelled' };

  const decidedAtMs = deps.nowMs();
  let lastStatusKind: string | null = null;
  let outcome: PluginInstallDecisionOutcome | null = null;
  try {
    await waitFor(async () => {
      const status = await deps.runCli({
        cliEntrypoint,
        env,
        args: ['plugins', 'change', 'status', input.pendingChangeId, '--json'],
      });
      const envelope = readJsonEnvelope(status.stdout, 'status');
      if (envelope.ok !== true) {
        lastStatusKind = 'daemonUnavailable';
        return false;
      }
      const data = envelope.data as Readonly<Record<string, unknown>> | undefined;
      lastStatusKind = typeof data?.kind === 'string' ? data.kind : null;
      if (lastStatusKind === 'terminal') {
        outcome = projectTerminalResult(data?.result);
        return true;
      }
      if (lastStatusKind === 'expired') {
        outcome = { kind: 'expired' };
        return true;
      }
      return false;
    }, {
      timeoutMs: deps.settleTimeoutMs,
      intervalMs: 250,
      context: `plugin install ${input.pendingChangeId} to settle`,
    });
  } catch (error) {
    throw new AuthenticatedPluginInstallReviewTimeoutError({
      pendingChangeId: input.pendingChangeId,
      decidedAtMs,
      timedOutAtMs: deps.nowMs(),
      lastStatusKind,
    }, { cause: error });
  }
  return outcome!;
}
