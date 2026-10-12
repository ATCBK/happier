import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { buildMachineAgentInventoryDescriptors as buildProtocolMachineAgentInventoryDescriptors, type MachineAgentInventoryDescriptor, type MachineAcpInventoryDefinition } from '@happier-dev/protocol/capabilities';

export function buildMachineAgentInventoryDescriptors(inputs: Readonly<{
    pluginProjectionV2: Pick<PluginProjectionV2, 'agentsById'> | null;
    definitions?: readonly Pick<MachineAcpInventoryDefinition, 'definitionId' | 'title'>[];
}> | null): readonly MachineAgentInventoryDescriptor[] {
    return inputs?.pluginProjectionV2
        ? buildProtocolMachineAgentInventoryDescriptors(inputs.pluginProjectionV2, inputs.definitions)
        : [];
}
