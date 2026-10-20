import { describe, expect, it } from 'vitest';
import { EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import { readPluginUiExecutionOriginCandidates, unionPluginUiProjections, type PluginUiProjectionUnionMember } from './projectionUnion';

describe('execution-origin projection identity', () => {
    it('retains unchanged facts across union publications and invalidates source withdrawal', () => {
        const pluginId = 'example.identity';
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'identity-source' };
        const origin = { serverIdentityId: 'srv_identity', sourceRef: { pluginId, machineId: 'machine', sourceCustody } };
        const source: PluginUiProjectionUnionMember = {
            machineId: 'machine', serverId: 'srv_identity', serverIdentityId: 'srv_identity', phase: 'current', interactionEnabled: true,
            projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1, installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Identity', version: '1.0.0', enabled: true,
                    source: { kind: 'localPath', locator: '/identity' }, occurrenceId: 'occurrence', sourceCustody, executionOrigin: origin },
            } },
        };
        const read = (member: PluginUiProjectionUnionMember, previous?: ReturnType<typeof readPluginUiExecutionOriginCandidates>) =>
            readPluginUiExecutionOriginCandidates({ pluginId, members: [member],
                projection: unionPluginUiProjections([member]).pluginUiProjection, previous });
        const initial = read(source);
        expect(initial.sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        const repeated = read({ ...source }, initial);
        expect(repeated).toBe(initial);
        const withdrawn = read({ ...source, phase: 'retainedOffline', interactionEnabled: false }, initial);
        expect(withdrawn).not.toBe(initial);
        expect(withdrawn.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason: 'stale' });
        expect(read(source, withdrawn).sourceCandidates[0]?.validation).toEqual({ kind: 'admitted' });
        const successor = { ...source, projection: { ...source.projection!, generation: 2 } };
        expect(read(successor, initial).sourceCandidates[0]?.source.generation).toBe(2);
    });
});
