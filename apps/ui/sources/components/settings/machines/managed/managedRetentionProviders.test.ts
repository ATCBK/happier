import { describe, expect, it } from 'vitest';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { projectManagedRetentionProviders } from './managedRetentionProviders';

describe('Defaults provisioner names', () => {
    it('names each category from real declared billing, never a provider id or a guessed billing model', () => {
        const localized = createPluginLocalizedTextResolver({ projection: null });
        const rows = [
            { contribution: { pluginId: 'custom.cloud-name', localId: 'a' }, descriptor: { title: 'Local compute', kindTitle: { key: 'local', fallback: 'VM' }, billing: { location: 'local' as const, stoppedBilling: 'unknown' as const } } },
            { contribution: { pluginId: 'custom.local-name', localId: 'b' }, descriptor: { title: 'Running service', billing: { location: 'cloud' as const, stoppedBilling: 'not-billed' as const } } },
            { contribution: { pluginId: 'custom.compute', localId: 'c' }, descriptor: { title: 'Fixed service', billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const } } },
            { contribution: { pluginId: 'custom.compute', localId: 'd' }, descriptor: { title: 'Unknown service', billing: { location: 'cloud' as const, stoppedBilling: 'unknown' as const } } },
        ];
        // The same declared service may be installed on more than one controller.
        expect(projectManagedRetentionProviders([...rows, rows[0]!], localized)).toEqual({ local: ['Local compute VM'], 'running-only': ['Running service'], 'stopped-billed': ['Fixed service'], unknown: ['Unknown service'] });
    });
});
