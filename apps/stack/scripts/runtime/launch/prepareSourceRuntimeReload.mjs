import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { buildSourceRuntimeBundle, admitSourceRuntimeReload, readSourceRuntimeInputConflict } from '../../build/build_source_runtime.mjs';
import { exportSourceWebUi } from '../../build/build_source_web_ui.mjs';
import { parseArgs } from '../../utils/cli/args.mjs';
import { resolveSourceQaUiMode } from '../shared/borrowed_expo.mjs';
import { beginPendingSourceStart, emitSourcePreparationPhase } from '../shared/pending_source_start.mjs';
import { resolveControlledRuntimePlacement } from '../../utils/dev_targets/service_placement.mjs';
import { applyServerHostDatabaseProviderEnv } from '../../utils/server/apply_runtime_server_database_env.mjs';
import { applyEffectiveDbProviderEnv } from '../../utils/server/effective_db_provider.mjs';
import { resolveStackDaemonStartRequested } from '../../utils/auth/daemon_gate.mjs';
import { writeJsonAtomic } from '../../utils/fs/json.mjs';
import { getServerComponentName } from '../../utils/server/server.mjs';
import { resolveDevServerConnection } from '../../utils/dev/resolveDevServerConnection.mjs';
import { resolveStackServerEndpoint } from '../../utils/server/urls.mjs';

/** Called by the existing restart owner before any incumbent retirement. */
export async function prepareSourceRuntimeReload({ stackName, stackBaseDir, repoDir, args, env,
  activation = Promise.resolve(true), onPrepared = async () => {}, onHost = false, onPhase, sourceStartRequestId }) {
  const { flags, kv } = parseArgs(args);
  const uiMode = resolveSourceQaUiMode({ uiMode: kv.get('--ui') ?? (flags.has('--ui') ? '' : undefined),
    noUi: flags.has('--no-ui'), consumerStackName: stackName, producerStackName: env.HAPPIER_STACK_EXPO_SOURCE_STACK });
  const serverComponent = getServerComponentName({ kv, env });
  const connection = resolveDevServerConnection({ flags, kv, env,
    resolvedLocalUrls: { internalServerUrl: '', publicServerUrl: '' } });
  const placement = onHost || flags.has('--no-dev-targets') ? null : await resolveControlledRuntimePlacement({
    stackName, stackBaseDir, sourceDir: repoDir, env });
  const pending = await beginPendingSourceStart({ stackBaseDir, onPhase, repoDir, env,
    requestId: sourceStartRequestId ?? kv.get('--source-start-request-id'),
    ...(onHost ? { replacePending: true } : {}) });
  const cancel = () => pending.abort(new Error('[reload] source preparation interrupted; incumbent retained'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const sourceRoot = join(stackBaseDir, 'source-runtime');
  const statusPath = join(sourceRoot, 'reload.json');
  const logDir = join(stackBaseDir, 'logs');
  const logPath = join(logDir, `run.reload.${Date.now()}.log`);
  const log = async message => { console.log(message); await appendFile(logPath, `${message}\n`); };
  try {
    await mkdir(logDir, { recursive: true });
    await writeJsonAtomic(statusPath, { status: 'preparing', logPath });
    await log('[reload] preparing replacement while incumbent runtime remains loaded');
    if (placement?.target && !connection.startServer) {
      throw new Error('[reload] remote server placement cannot be activated with an external-server source start; incumbent retained');
    }
    const remote = placement?.target || placement?.daemonTarget
      ? await (await import('../../utils/dev_targets/supervisor.mjs')).prepareStackDevTargetSourceReload({
          stackName, stackBaseDir, repoDir, placement, args, serverRequested: connection.startServer,
          env: { ...env, HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
            HAPPIER_SERVER_URL: connection.startServer
              ? (await resolveStackServerEndpoint({ env, stackName })).internalServerUrl : connection.internalServerUrl },
          sourceStartRequestId: pending.requestId,
          signal: pending.signal, onPhase: (target, phase) => pending.setPhase(phase, target) }) : null;
    try {
      if (serverComponent !== 'happier-server-light' && connection.startServer) {
        throw new Error('[reload] full-server smoke requires isolated managed infrastructure; incumbent retained');
      }
      const serverEnv = { ...env };
      const dbProvider = connection.startServer && !placement?.target
        ? applyServerHostDatabaseProviderEnv({ serverComponentName: serverComponent, env: serverEnv })
        : applyEffectiveDbProviderEnv({ serverComponentName: serverComponent, env: serverEnv });
      const components = {};
      const prepareServer = () => buildSourceRuntimeBundle({ repoDir, stackBaseDir, pending, component: 'server',
        serverComponent, dbProvider, env: serverEnv, signal: pending.signal });
      if (connection.startServer && !placement?.target) components.server = await prepareServer();
      if (!placement?.daemonTarget && resolveStackDaemonStartRequested({ env, noDaemon: flags.has('--no-daemon') })) {
        components.daemon = await buildSourceRuntimeBundle({ repoDir, stackBaseDir, pending,
          component: 'daemon', env, signal: pending.signal });
      }
      if (components.server && components.daemon) {
        const initialConflict = await readSourceRuntimeInputConflict({ stackBaseDir, replacements: components });
        if (initialConflict) {
          await log(`[reload] protocol input changed between component captures; rebuilding earlier server candidate (${initialConflict.conflictingInput})`);
          components.server = await prepareServer();
          const remainingConflict = await readSourceRuntimeInputConflict({ stackBaseDir, replacements: components });
          if (remainingConflict) {
            throw Object.assign(
              new Error(`[source-bundle] protocol input ${remainingConflict.conflictingInput} changed again while converging replacement components; existing Stack lifecycle must retry preparation`),
              { code: 'source_runtime_reload_retry_required', ...remainingConflict },
            );
          }
        }
      }
      const ui = components.server && uiMode === 'export' ? await exportSourceWebUi({ repoDir, baseDir: sourceRoot,
        stackBaseDir, pending, env, signal: pending.signal }) : null;
      await log('[reload] build complete; checking replacement daemon loader, server health and UI boot');
      await pending.setPhase({ phase: 'checking' });
      const admitted = await admitSourceRuntimeReload({ stackBaseDir, components, ui, pending,
        env: { ...serverEnv, HAPPIER_STACK_REPO_DIR: repoDir } });
      await pending.setPhase({ phase: 'prepared' });
      await onPrepared({ ui });
      if (!await activation) throw new Error('[reload] preparation cancelled before selection; incumbent retained');
      pending.signal.throwIfAborted();
      await remote?.activate();
      await admitted.activate();
      // Successful selection is already authoritative. A diagnostic write must
      // not mislabel a validated graph as a failed preparation afterwards.
      await writeJsonAtomic(statusPath, { status: 'ready', logPath }).catch(error => console.error('[reload] diagnostic publication failed:', error));
      await log('[reload] replacement smoke passed; incumbent may now be retired by the restart owner')
        .catch(error => console.error('[reload] log publication failed:', error));
      return { ui, remote: Boolean(remote), remoteDaemon: Boolean(placement?.daemonTarget) };
    } finally { await remote?.close(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(statusPath, { status: 'failed', message, logPath })
      .catch(diagnostic => console.error('[reload] failure diagnostic publication failed:', diagnostic));
    await log(`[reload] replacement refused; incumbent retained: ${message}`)
      .catch(diagnostic => console.error('[reload] failure log publication failed:', diagnostic));
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await pending.dispose();
  }
}

// The existing remote executor owns this worker and its control pipe. It only
// prepares/selects source bytes; Stack retirement stays with the restart owner.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  const request = JSON.parse(process.argv[3]);
  const control = createInterface({ input: process.stdin });
  let decide;
  const activation = new Promise(resolve => { decide = resolve; });
  control.on('line', line => { if (line === 'activate') decide(true); else if (line === 'cancel') decide(false); });
  control.on('close', () => decide(false));
  try {
    await prepareSourceRuntimeReload({ ...request, env: process.env, onHost: true, activation,
      onPhase: emitSourcePreparationPhase,
      onPrepared: () => process.stdout.write('HSTACK_SOURCE_RELOAD_PREPARED\n') });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally { control.close(); }
}
