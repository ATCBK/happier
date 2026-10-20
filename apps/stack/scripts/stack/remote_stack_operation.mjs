import { getRepoDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { resolveDevTargetMutagenRuntime, resolveDevTargetSshConfigFile } from '../utils/dev_targets/mutagen_runtime.mjs';
import { flushDevTargetSync, runDevTargetControlProcess } from '../utils/dev_targets/sync_project.mjs';
import { buildRemoteRuntimeSnapshotProbeCommand, buildRemoteStackOperationCommand, buildSshWorkerArgs } from '../utils/dev_targets/remote_commands.mjs';
import { recordStackRuntimeUpdate } from '../utils/stack/runtime_state.mjs';

/** Reuse the transport, freshness barrier and retained Stack scope for narrow commands. */
export async function runRemoteStackOperation({ rootDir, stackName, placed, operation, passthrough, env }) {
  const { target, runtimeMode } = placed;
  const { baseDir } = resolveStackEnvPath(stackName, env);
  const sync = resolveDevTargetMutagenRuntime({ stackBaseDir: baseDir, sourceDir: getRepoDir(rootDir, env), env });
  await flushDevTargetSync({ target, env: sync.env });
  const configFile = resolveDevTargetSshConfigFile(target, { stackBaseDir: baseDir, env });
  const sshArgs = configFile ? ['-F', configFile] : [];
  const result = await runDevTargetControlProcess({ command: 'ssh', env,
    args: buildSshWorkerArgs(target, {
      remoteCommand: buildRemoteStackOperationCommand(target, { stackName, runtimeMode, operation, passthrough }),
      sshArgs,
    }) });
  if (result.code !== 0) throw new Error(result.err || `[stack] remote ${operation} failed (code=${result.code})`);
  if (operation === 'daemon' && (passthrough.includes('start') || passthrough.includes('restart'))
    && runtimeMode === 'source-snapshot') {
    const observation = await runDevTargetControlProcess({ command: 'ssh', env,
      args: [...sshArgs, '-o', 'BatchMode=yes', target.ssh,
        buildRemoteRuntimeSnapshotProbeCommand(target, { stackName, runtimeMode, services: { daemon: true } })] });
    if (observation.code !== 0) throw new Error(observation.err || '[stack] restarted source daemon identity is not loaded');
    const { sourceRuntimeIdentities } = JSON.parse(observation.out);
    if (!sourceRuntimeIdentities?.daemon?.selected
      || sourceRuntimeIdentities.daemon.loaded !== sourceRuntimeIdentities.daemon.selected) {
      throw new Error('[stack] restarted source daemon identity is not loaded');
    }
    await recordStackRuntimeUpdate(env.HAPPIER_STACK_RUNTIME_STATE_PATH, {
      placement: { daemon: target.name },
      sourceRuntimeIdentities,
      // The next server-only start consumes observed daemon custody, not just
      // its configured target or a source identity without a recorded role.
      remoteTargets: { [target.name]: { runtimeMode, services: { daemon: true },
        serviceStatus: { daemon: 'running' }, sourceRuntimeIdentities } },
    });
  }
  process.stdout.write(result.out || '');
}
