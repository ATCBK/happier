import { z } from 'zod/mini';

import { claimDaemonForegroundAgentRuntime } from '@/daemon/controlClient';
import {
  HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY,
  ForegroundAgentRuntimeClaimResponseV1Schema,
} from '@/daemon/agentRuntime/foregroundAdmissionContract';
import { readPrivateBearerFile } from '@/daemon/privateBearerFile';
import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
} from './agentRuntimeRunnerProtocol';

const ForegroundAdmissionHandoffSchema = z.strictObject({
  v: z.literal(1),
  capability: z.string().check(z.minLength(1), z.maxLength(4_096)),
  descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
});

export async function claimDaemonForegroundAgentRuntimeEnvironment(
  params: Readonly<{
    env: NodeJS.ProcessEnv;
    provisionalSessionId: string;
    canonicalSessionId: string;
    attemptId: string;
    foregroundPid: number;
    foregroundSatisfiedProfileSecretRequirementNames: readonly string[];
    nativeHomeSourceEnvironmentValue?: string | null;
    signal?: AbortSignal;
  }>,
) {
  const admissionFilePath =
    params.env[
      HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY
    ]?.trim() ?? '';
  if (!admissionFilePath) {
    throw new Error('Foreground Agent runtime admission capability is missing');
  }
  const handoff = ForegroundAdmissionHandoffSchema.parse(
    JSON.parse(await readPrivateBearerFile(admissionFilePath)),
  );
  return ForegroundAgentRuntimeClaimResponseV1Schema.parse(
    await claimDaemonForegroundAgentRuntime({
      v: 1,
      attemptId: params.attemptId,
      provisionalSessionId: params.provisionalSessionId,
      canonicalSessionId: params.canonicalSessionId,
      foregroundPid: params.foregroundPid,
      pluginId: handoff.descriptor.pluginId,
      agentId: handoff.descriptor.agentId,
      occurrenceId: handoff.descriptor.occurrenceId,
      sourceCustody: handoff.descriptor.sourceCustody,
      capability: handoff.capability,
      foregroundSatisfiedProfileSecretRequirementNames:
        [...params.foregroundSatisfiedProfileSecretRequirementNames],
      ...(params.nativeHomeSourceEnvironmentValue === undefined
        ? {}
        : {
            nativeHomeSourceEnvironmentValue:
              params.nativeHomeSourceEnvironmentValue,
          }),
    }, {
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  );
}
