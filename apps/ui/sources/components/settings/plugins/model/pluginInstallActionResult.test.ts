import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { MarketplaceRegistryProfileRequiredResultV1Schema } from '@happier-dev/protocol/marketplace';
import { projectPluginInstallActionResult, readPluginChangeKind, readPluginRegistryProfileRequirement } from './pluginMarketplaceModel';

describe('plugin install Action result adaptation', () => {
    it('keeps the requested update identity and the daemon committed result', () => {
        const change = { kind: 'committed', pluginId: 'acme.plugin', desiredGeneration: 'new', appliedGeneration: 'new', pendingSurfaces: [] };
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const emitted = outputSchema.parse({ ok: true, kind: 'plugins_install', outcome: 'applied', change });
        const result = projectPluginInstallActionResult(emitted, 'update', 'acme.plugin');
        expect(readPluginChangeKind(result, 'update', 'acme.plugin')).toBe('committed');
        expect(result.change).toEqual(change);
    });

    it('preserves an ambiguous daemon result for the existing exact-target reconciler', () => {
        const change = { kind: 'outcomeUnknown', pluginId: 'acme.plugin', expectedCandidate: 'candidate-2' };
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const emitted = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed', change });
        const result = projectPluginInstallActionResult(emitted, 'install', 'acme.plugin');
        expect(readPluginChangeKind(result, 'install', 'acme.plugin')).toBe('outcomeUnknown');
        expect(result.change).toEqual(change);
    });

    it('preserves the installing Home’s registry selection requirement', () => {
        const change = MarketplaceRegistryProfileRequiredResultV1Schema.parse({ kind: 'registryProfileRequired',
            registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: null });
        const outputSchema = getActionSpec('plugins.install').outputSchema;
        if (!outputSchema) throw new Error('Expected the plugin install Action output schema');
        const emitted = outputSchema.parse({ ok: false, kind: 'plugins_install', outcome: 'failed', change });
        const result = projectPluginInstallActionResult(emitted, 'install', 'acme.plugin');
        expect(readPluginRegistryProfileRequirement(result, 'install', 'acme.plugin')).toEqual({
            registryOrigin: 'https://registry.example', packageName: '@acme/plugin', registryProfileId: null,
        });
    });
});
