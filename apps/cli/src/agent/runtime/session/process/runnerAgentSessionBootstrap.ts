import { readPrivateBearerFile } from '@/daemon/privateBearerFile';
import { AgentRuntimeRunnerBootstrapV1Schema } from './agentRuntimeRunnerProtocol';

/** One protected, strict reader for runner launch intent and runtime construction. */
export async function readRunnerAgentSessionBootstrap(
  path: string,
): Promise<ReturnType<typeof AgentRuntimeRunnerBootstrapV1Schema.parse>> {
  return AgentRuntimeRunnerBootstrapV1Schema.parse(
    JSON.parse(await readPrivateBearerFile(path)),
  );
}
