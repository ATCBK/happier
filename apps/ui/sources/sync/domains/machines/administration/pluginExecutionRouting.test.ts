import { describe, expect, it } from 'vitest';
import {
    PluginMachineExecutionRoutingV1JsonSchema,
    PluginMachineExecutionRoutingV1Schema,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { normalizePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

describe('UI routing schema import', () => {
    it('consumes the canonical plain JSON projection without validator metadata', () => {
        const schema = normalizePluginJsonSchema(PluginMachineExecutionRoutingV1JsonSchema);
        const routing = { serverIdentityId: 'srv_ui_import', machineId: 'machine-ui', pluginId: 'happier.channels' };
        expect(schema).toEqual(PluginMachineExecutionRoutingV1Schema.jsonSchema);
        expect(PluginMachineExecutionRoutingV1Schema.parse(routing)).toEqual(routing);
        expect(PluginMachineExecutionRoutingV1Schema.safeParse({ ...routing, materializationId: 'old-custody' }).success).toBe(false);
    });
});
