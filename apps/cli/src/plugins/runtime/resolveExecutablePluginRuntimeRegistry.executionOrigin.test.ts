import { describe, expect, it } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

describe('current runtime execution origin', () => {
    it('uses the admitted source custody and refuses a retired occurrence', async () => {
        const pluginId = 'happier.inspector';
        const context = { serverIdentityId: 'srv_runtime_source_origin', machineId: 'machine-source-origin' };
        let retireDuringContextRead = false;
        let contextMachineId = context.machineId;
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [pluginId],
            resolveCurrentMachineId: () => context.machineId,
            resolveCurrentMachineExecutionOriginContext: async () => {
                if (retireDuringContextRead) await fixture.registry.retirePluginConsumers?.([pluginId]);
                return { ...context, machineId: contextMachineId };
            },
        } });
        try {
            expect(await fixture.registry.activatePluginsForValidation?.([pluginId])).toEqual([
                { pluginId, diagnostics: [] },
            ]);
            const sourceCustody = fixture.registry.readPluginSourceCustody?.(pluginId);
            expect(sourceCustody).toBeTruthy();
            await expect(fixture.registry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toEqual({
                serverIdentityId: context.serverIdentityId,
                sourceRef: { machineId: context.machineId, pluginId, sourceCustody },
            });
            contextMachineId = 'machine-replacement';
            await expect(fixture.registry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toBeNull();
            contextMachineId = context.machineId;
            const aborted = new AbortController();
            aborted.abort();
            await expect(fixture.registry.resolveCurrentPluginExecutionOrigin?.(pluginId, aborted.signal)).rejects.toThrow();
            retireDuringContextRead = true;
            await expect(fixture.registry.resolveCurrentPluginExecutionOrigin?.(pluginId)).resolves.toBeNull();
        } finally {
            await fixture.dispose();
        }
    });
});
