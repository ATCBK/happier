import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PluginError } from '@happier-dev/plugin-sdk';
import { acquireExecutionRunRuntimeSnapshot } from '@/rpc/handlers/executionRuns/acquireExecutionRunRuntimeSnapshot';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { RunnerExecutionRunSnapshotV1Schema } from '@/agent/runtime/session/process/executionRunSnapshotProtocol';
import type { AgentRuntimeDaemonServiceRoutes } from '@/daemon/controlServer';
import type { TrackedSession } from '@/daemon/types';

type Context = Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1];
type Request = Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[0];
type Held = Readonly<{ context: Context;
  snapshot: Awaited<ReturnType<typeof acquireExecutionRunRuntimeSnapshot>>;
  projection: ReturnType<typeof RunnerExecutionRunSnapshotV1Schema.parse>;
}>;

/** Custody of the canonical producer's leases, never a second Run or catalog registry. */
export function createRunnerExecutionRunSnapshots(input: Readonly<{ machineId: string; controller?: PluginReloadController }>) {
  const held = new Map<string, Held>();
  const unavailable = () => { throw new PluginError({ code: 'execution_run_contribution_snapshot_unavailable',
    message: 'Execution Run executable snapshot is unavailable' }); };
  const read = (snapshotId: string, context: Pick<Context, 'sessionId' | 'runner' | 'retainedAgent'>) => {
    const value = held.get(snapshotId);
    return value && value.context.sessionId === context.sessionId
      && isDeepStrictEqual(value.context.runner, context.runner)
      && isDeepStrictEqual(value.context.retainedAgent, context.retainedAgent) ? value : null;
  };
  const release = async (snapshotId: string) => {
    const value = held.get(snapshotId);
    if (!value) return;
    held.delete(snapshotId);
    await value.snapshot.release();
  };
  return Object.freeze({
    read,
    async dispatch(request: Request, context: Context) {
      const operation = request.operation;
      if (operation.kind === 'execution_run.snapshot.acquire_v1') {
        if (!context.trackedSession || !await context.isCurrent()) return unavailable();
        context.signal?.throwIfAborted();
        const snapshot = await acquireExecutionRunRuntimeSnapshot({ sessionId: context.sessionId,
          machineId: input.machineId }, input.controller);
        try {
          const backendId = operation.backendTarget?.backendId ?? null;
          const descriptor = backendId ? await resolveRunnerAgentSessionDescriptorForLease({
            target: operation.backendTarget!, lease: snapshot.runtimeRegistryLease }) : null;
          const registration = descriptor ? snapshot.runtimeRegistry.agentRuntimesByAgentId.get(descriptor.agentId) : null;
          const binding = registration?.hasPrimaryRuntime ? registration.sessionRunnerFactoryBinding : undefined;
          if (operation.backendTarget && (!descriptor || !binding || !registration?.isCurrent())) return unavailable();
          const projection = RunnerExecutionRunSnapshotV1Schema.parse({ kind: 'execution_run.snapshot', snapshotId: randomUUID(),
            ...(descriptor && binding ? { agent: { descriptor, binding } } : {}),
            profiles: [...snapshot.profileCatalog.profileDescriptorsById.values()].flatMap(profile =>
              profile.pluginId && profile.sourceCustody ? [{ pluginId: profile.pluginId,
                sourceCustody: profile.sourceCustody, definition: profile.definition }] : []),
          });
          context.signal?.throwIfAborted();
          if (!await context.isCurrent()) return unavailable();
          held.set(projection.snapshotId, { context, snapshot, projection });
          return { ok: true as const, result: projection };
        } catch (error) {
          await snapshot.release();
          throw error;
        }
      }
      if (operation.kind === 'execution_run.snapshot.release_v1') {
        if (!read(operation.snapshotId, context)) return unavailable();
        await release(operation.snapshotId);
        return { ok: true as const, result: { kind: 'execution_run.snapshot.released' as const } };
      }
      return unavailable();
    },
    async releaseForRunnerExit(tracked: TrackedSession) {
      await Promise.all([...held].filter(([, value]) => value.context.trackedSession === tracked)
        .map(([snapshotId]) => release(snapshotId)));
    },
    async dispose() { await Promise.all([...held.keys()].map(release)); },
  });
}
