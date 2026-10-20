import {
    InstalledPluginCapabilityEntryV1Schema,
    type InstalledPluginCapabilityEntryV1,
} from '@happier-dev/protocol/capabilities';

/** A daemon-installed record, admitted by the same schema as its UI reader. */
export function createInstalledPluginCapabilityFixture(
    overrides: Partial<InstalledPluginCapabilityEntryV1> & Pick<InstalledPluginCapabilityEntryV1, 'pluginId'>,
): InstalledPluginCapabilityEntryV1 {
    return InstalledPluginCapabilityEntryV1Schema.parse({
        title: overrides.pluginId,
        description: null,
        version: '1.0.0',
        enabled: true,
        source: { kind: 'npm', locator: overrides.pluginId },
        install: { mode: 'npm', manifestVersion: '2' },
        compatibility: { status: 'compatible', diagnostics: [] },
        diagnostics: [],
        ...overrides,
    });
}
