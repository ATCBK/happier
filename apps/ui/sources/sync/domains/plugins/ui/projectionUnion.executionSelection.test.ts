import { expect, it } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { resolvePluginMachineExecutionOriginState } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { createPluginUiProjectionUnionPublication, readPluginUiContributionOrigin, readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates, unionPluginUiProjections } from './projectionUnion';

it('never appoints even a sole producer before Administration selects it', () => {
    const pluginId = 'acme.execution-selection';
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'selection-root' };
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_selection',
        sourceRef: { pluginId, machineId: 'machine-a', sourceCustody } });
    const projection = widgetProjectionOf([{ pluginId, localId: 'latest', target: 'app', occurrenceId: 'slot-a' }], {
        [pluginId]: { id: pluginId, displayName: 'Latest entries', enabled: true, version: '1.0.0', occurrenceId: 'slot-a',
            executionOrigin: origin, sourceCustody, source: { kind: 'localPath', locator: 'selection-root' } },
    });
    const members = [{ machineId: 'machine-a', serverId: 'home-a', serverIdentityId: 'srv_selection',
        phase: 'current' as const, interactionEnabled: true, projection }];
    const unselected = unionPluginUiProjections(members).pluginUiProjection!;
    const key = `surfacePlacement:${pluginId}:latest`;
    expect(readPluginUiContributionOrigin(unselected.surfacePlacementsById[key])).toBeNull();
    const facts = readPluginUiExecutionOriginCandidates({ projection: unselected, pluginId });
    const decision = resolvePluginMachineExecutionOriginState({ pluginId, storedOrigin: null,
        candidates: facts.sourceCandidates, ...facts });
    expect(decision.kind).toBe('selected');
    if (decision.kind !== 'selected') throw new Error('Expected the canonical automatic decision');
    const selected = unionPluginUiProjections(members, new Map([[pluginId, decision.origin]])).pluginUiProjection!;
    expect(readPluginUiContributionOrigin(selected.surfacePlacementsById[key])).toMatchObject({ machineId: 'machine-a', executionOrigin: origin });
});

it('keeps each surface Resource capability with its exact supplier and refreshes changed facts', () => {
    const pluginId = 'acme.execution-selection';
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'selection-root' };
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_selection',
        sourceRef: { pluginId, machineId: 'machine-a', sourceCustody } });
    const base = widgetProjectionOf(['live', 'local'].map(localId => ({ pluginId, localId, target: 'app' as const, occurrenceId: 'slot-a' })), {
        [pluginId]: { id: pluginId, displayName: 'Resource facts', enabled: true, version: '1.0.0', occurrenceId: 'slot-a',
            executionOrigin: origin, sourceCustody, source: { kind: 'localPath', locator: 'selection-root' } },
    });
    const liveKey = `surfacePlacement:${pluginId}:live`;
    const localKey = `surfacePlacement:${pluginId}:local`;
    const member = (dynamic: boolean) => ({ machineId: 'machine-a', serverId: 'home-a', serverIdentityId: 'srv_selection',
        phase: 'current' as const, interactionEnabled: true, projection: { ...base, surfacePlacementsById: {
            ...base.surfacePlacementsById,
            [liveKey]: { ...base.surfacePlacementsById[liveKey]!, runtime: { resourceCapability: { readable: true, dynamic } } },
        } } });
    const publication = createPluginUiProjectionUnionPublication();
    const selections = new Map([[pluginId, origin]]);
    const initial = publication.publish([member(true)], selections).pluginUiProjection!;
    expect(readPluginUiContributionSupplies(initial.surfacePlacementsById[liveKey])[0]?.resourceCapability)
        .toEqual({ readable: true, dynamic: true });
    expect(readPluginUiContributionSupplies(initial.surfacePlacementsById[localKey])[0]?.resourceCapability)
        .toEqual({ readable: false, dynamic: false });
    const changed = publication.publish([member(false)], selections).pluginUiProjection!;
    expect(readPluginUiContributionSupplies(changed.surfacePlacementsById[liveKey])[0]?.resourceCapability)
        .toEqual({ readable: true, dynamic: false });
});
