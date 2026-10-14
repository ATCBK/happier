import type { PluginMachineExecutionOriginV1, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

/** One identity producer for projection and invocation, using their admitted source facts. */
export function resolvePluginMachineExecutionOrigin(input: Readonly<{
    pluginId: string;
    context: CurrentMachineExecutionOriginContext;
    /** Only an actual install-registry materialization belongs here. */
    materializationId?: string;
    sourceCustody?: PluginSourceCustodyV1 | null;
}>): PluginMachineExecutionOriginV1 | null {
    const origin = PluginMachineExecutionOriginV1Schema.safeParse({
        serverIdentityId: input.context.serverIdentityId,
        ...(input.materializationId !== undefined
            ? { materializationRef: {
                machineId: input.context.machineId,
                pluginId: input.pluginId,
                materializationId: input.materializationId,
            } }
            : { sourceRef: {
                machineId: input.context.machineId,
                pluginId: input.pluginId,
                sourceCustody: input.sourceCustody,
            } }),
    });
    return origin.success ? Object.freeze(origin.data) : null;
}
