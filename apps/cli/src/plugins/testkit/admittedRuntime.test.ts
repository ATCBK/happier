import { describe, expect, it } from 'vitest';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from './admittedRuntime';

describe('admitted runtime fixture controller lifetime', () => {
    it('releases each fixture without shutting down its caller-owned controller', async () => {
        const controller = createPluginReloadController();
        const runtimeOptions = { pluginIds: [], contributes: createResolvedContributionRegistry({}) };
        try {
            const first = await createAdmittedPluginRuntimeFixture({ controller, runtimeOptions });
            await first.dispose();
            expect(controller.isRuntimeRegistryCurrent(first.registry)).toBe(false);

            const second = await createAdmittedPluginRuntimeFixture({ controller, runtimeOptions });
            try {
                expect(controller.isRuntimeRegistryCurrent(second.registry)).toBe(true);
            } finally {
                await second.dispose();
            }
        } finally {
            await controller.shutdown();
        }
    });
});
