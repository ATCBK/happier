import { expect, it } from 'vitest';
import { projectPluginRegistrySourceDeclarationV1 } from '@happier-dev/protocol/registries';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { projectPluginRegistrySources } from './pluginRegistrySources';

const pluginId = 'com.acme.sources';
const origin = (machineId: string) => ({ serverIdentityId: 'srv_registry_sources', materializationRef: {
    machineId, pluginId, materializationId: machineId,
} });
const member = (machineId: string, url = `https://github.com/acme/${machineId}`) => ({ machineId, serverId: 'srv_registry_sources', phase: 'current' as const,
    interactionEnabled: true, selectableExecutionOrigins: [origin(machineId)],
    projection: { ...normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme sources',
        version: '1.0.0', enabled: true, occurrenceId: machineId, source: { kind: 'path', locator: `/plugins/${machineId}` } }, [{
        ...projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
            id: 'skills', title: 'Team skills', format: 'git', kinds: ['skill'], url,
        } }), occurrenceId: machineId, executionOrigin: origin(machineId),
    }]), generation: 1 },
});

it.each([false, true])('keeps matching offline suppliers of the chosen source and refuses unresolved conflicts (reversed: %s)', reverse => {
    const members = [member('first'), member('second'), {
        ...member('retained', 'https://github.com/acme/second'), phase: 'retainedOffline' as const, interactionEnabled: false,
    }];
    if (reverse) members.reverse();
    const conflict = unionPluginUiProjections(members).pluginUiProjection;
    expect(() => projectPluginRegistrySources(conflict)).toThrow();
    const selected = unionPluginUiProjections(members, new Map([[pluginId, origin('second')]])).pluginUiProjection;
    const sources = projectPluginRegistrySources(selected);
    expect(sources).toMatchObject([{ url: 'https://github.com/acme/second',
        origin: { kind: 'plugin', suppliers: expect.arrayContaining(['second', 'retained']) } }]);
    const source = sources[0];
    if (source?.origin.kind !== 'plugin') throw new Error('Expected a plugin-owned source');
    expect(source.origin.suppliers).not.toContain('first');
});

it.each([false, true])('rebuilds only matching suppliers when an unselected retained declaration changes (reversed: %s)', reverse => {
    const current = member('current', 'https://github.com/acme/current');
    const retained = { ...member('retained', 'https://github.com/acme/current'),
        phase: 'retainedOffline' as const, interactionEnabled: false };
    const project = (offline: typeof retained) => projectPluginRegistrySources(unionPluginUiProjections(
        reverse ? [offline, current] : [current, offline],
    ).pluginUiProjection);
    expect(project(retained)).toMatchObject([{ url: 'https://github.com/acme/current',
        origin: { kind: 'plugin', suppliers: expect.arrayContaining(['current', 'retained']) } }]);
    const refreshed = { ...retained, projection: member('retained', 'https://github.com/acme/other').projection };
    expect(project(refreshed)).toMatchObject([{ url: 'https://github.com/acme/current',
        origin: { kind: 'plugin', suppliers: ['current'] } }]);
});
