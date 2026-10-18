import * as zMini from 'zod/mini';
import { z } from 'zod';
import { BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { PluginExecutionRunProfileContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/executionRunProfiles';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { AgentSessionRunnerBindingV1Schema } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { AgentRuntimeDaemonSessionDescriptorV1Schema } from './agentRuntimeRunnerProtocol';

// Host-private optional operations. Older daemons reject unknown operations;
// that refusal cannot be interpreted as an empty executable snapshot.
export const RUNNER_EXECUTION_RUN_SNAPSHOT_OPERATIONS = [
  z.object({ kind: z.literal('execution_run.snapshot.acquire_v1'),
    backendTarget: asHostProtocolZod(zMini.core.clone(BackendTargetRefV2Schema, { ...BackendTargetRefV2Schema._zod.def, catchall: zMini.never() })).optional() }).strict(),
  z.object({ kind: z.literal('execution_run.snapshot.release_v1'), snapshotId: z.uuid() }).strict(),
] as const;

export const RunnerExecutionRunSnapshotV1Schema = z.object({
  kind: z.literal('execution_run.snapshot'), snapshotId: z.uuid(),
  agent: z.object({ descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
    binding: AgentSessionRunnerBindingV1Schema }).strict().optional(),
  profiles: z.array(z.object({ pluginId: z.string().min(1),
    sourceCustody: asHostProtocolZod(PluginSourceCustodyV1Schema),
    definition: asHostProtocolZod(PluginExecutionRunProfileContributionV2Schema) }).strict()),
}).strict();
export const RUNNER_EXECUTION_RUN_SNAPSHOT_RESULTS = [
  RunnerExecutionRunSnapshotV1Schema,
  z.object({ kind: z.literal('execution_run.snapshot.released') }).strict(),
] as const;
export type RunnerExecutionRunSnapshotV1 = z.infer<typeof RunnerExecutionRunSnapshotV1Schema>;
