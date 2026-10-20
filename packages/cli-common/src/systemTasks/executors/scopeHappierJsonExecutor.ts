import type { HappierJsonExecutor } from './happierJsonExecutorFromTextRunner.js';

export type HappierServerScope = Readonly<{
  serverId: string;
  targetMode: 'pinned' | 'default-following';
  /**
   * Ask the CLI to mark this pinned service as the desktop's (`HAPPIER_DAEMON_SERVICE_MANAGED_BY`;
   * honored only by `service install`, and kept by every later rewrite).
   */
  managedBy?: 'desktop' | null;
}>;

/**
 * The selectors an inherited environment can use to point the CLI at another server, profile or
 * daemon lifecycle directory (the CLI's `configuration` reads exactly these). A stack-launched app
 * carries its stack's pin in them; `--server <id>` replaces the first five, but the lifecycle scope
 * would still put this Home's daemon state and lock in the stack's directory (R13 a).
 */
const INHERITED_SERVER_SELECTOR_ENV_KEYS = [
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_LOCAL_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  // Stronger service selectors must not override the explicit Home/profile or chosen CLI.
  'HAPPIER_DAEMON_SERVICE_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_WEBAPP_URL',
  'HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL',
  'HAPPIER_DAEMON_SERVICE_CHANNEL',
  'HAPPIER_DAEMON_SERVICE_NODE_PATH',
  'HAPPIER_DAEMON_SERVICE_ENTRY_PATH',
  'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
  'HAPPIER_DAEMON_SERVICE_PLATFORM',
  'HAPPIER_DAEMON_SERVICE_UID',
  'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
  'HAPPIER_DAEMON_SERVICE_MODE',
  'HAPPIER_DAEMON_SERVICE_SYSTEM_USER',
  'HAPPIER_DAEMON_SERVICE_BUNDLE_ID',
  // The desktop management marker: only a scope that asks for it carries it (R15).
  'HAPPIER_DAEMON_SERVICE_MANAGED_BY',
] as const;

/**
 * Scopes every invocation to one saved server profile (`--server <id>`, never persisted) and to
 * that profile's service shape (`HAPPIER_DAEMON_SERVICE_TARGET_MODE`), so `service …` and
 * `daemon status` address this Home's own service and daemon. It is the one context rule for an
 * explicit Home (R13 a): no inherited selector competes with the profile the command names.
 */
export function scopeHappierJsonExecutor(
  executor: HappierJsonExecutor,
  scope: HappierServerScope | HappierServiceFollowingScope,
  processEnv: NodeJS.ProcessEnv = process.env,
): HappierJsonExecutor {
  const scopedArgs = (args: readonly string[]) => (scope.serverId === null ? [...args] : ['--server', scope.serverId, ...args]);
  const scopedEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = { ...env, HAPPIER_DAEMON_SERVICE_TARGET_MODE: scope.targetMode };
    for (const key of INHERITED_SERVER_SELECTOR_ENV_KEYS) delete next[key];
    if (scope.targetMode === 'pinned' && 'managedBy' in scope && scope.managedBy === 'desktop') {
      next.HAPPIER_DAEMON_SERVICE_MANAGED_BY = 'desktop';
    }
    return next;
  };
  const scopedOpts = <T extends Readonly<{ env?: NodeJS.ProcessEnv }>>(opts: T | undefined): T => ({
    ...(opts ?? {}) as T,
    env: scopedEnv(opts?.env ?? processEnv),
  });
  return {
    runHappierText: async (args, opts) => await executor.runHappierText(scopedArgs(args), scopedOpts(opts)),
    runHappierJson: async (args, opts) => await executor.runHappierJson(scopedArgs(args), scopedOpts(opts)),
  };
}

/**
 * The default-following service's own scope: no `--server`, so it keeps following the server this
 * home's terminal selected — it is never repointed at a Home.
 */
export type HappierServiceFollowingScope = Readonly<{ serverId: null; targetMode: 'default-following' }>;
