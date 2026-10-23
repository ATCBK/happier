import { describe, expect, it } from 'vitest';
import type { AutomationDefinitionListResponse } from '../automations/automationApiV3.js';
import { createWorkBoardV1 } from '../boards/workBoardV1.js';
import type { ProfileCatalogSnapshotV1 } from '../profiles/profileCatalogV1.js';
import type { MachinePoolListOutputV1 } from './pools/v1.js';
import { readMachineReferenceCensusV1, type MachineReferenceCensusPortsV1 } from './machineReferenceCensusV1.js';

describe('readMachineReferenceCensusV1', () => {
  it('reads referenced launch profiles by exact id without scanning a scale-shaped other inventory', async () => {
    const machineId = 'machine-one';
    const board = {
      ...createWorkBoardV1({ id: 'board-one', name: 'Board one' }),
      source: { picked: [{ kind: 'machine' as const, qualifiedId: { serverId: 'home-alias', id: machineId } }] },
    };
    const artifacts = new Map([
      ['board-one', {
        artifactId: 'board-one', header: { kind: 'work-board.v1', v: 1 }, body: JSON.stringify(board),
        revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account', access: 'owner' as const,
      }],
      ['profile-one', {
        artifactId: 'profile-one', access: 'view' as const,
        header: { kind: 'launch-profile.v1', profileId: 'profile-one', name: 'Profile one' },
        body: JSON.stringify({ kind: 'launch-profile.v1', profile: {
          v: 2, id: 'profile-one', name: 'Profile one', createdAt: 1, updatedAt: 1,
          placement: { fixed: { serverId: 'home', machineId } },
        } }),
        revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account',
      }],
    ]);
    const listCalls: Parameters<MachineReferenceCensusPortsV1['artifacts']['list']>[0][] = [];
    const readCalls: { artifactId: string; fresh: boolean | undefined }[] = [];
    const readManyCalls: { artifactIds: readonly string[]; fresh: boolean | undefined }[] = [];
    const unrelatedOtherArtifacts = Array.from({ length: 5_000 }, (_, index) => ({
      artifactId: `unrelated-other-${index}`, header: { kind: 'unrelated-other.v1' }, headerVersion: 1,
      updatedAt: index, ownerAccountId: 'account', access: 'owner' as const,
    }));
    let assignmentReads = 0;
    const ports: MachineReferenceCensusPortsV1 = {
      artifacts: {
        async list(options) {
          listCalls.push(options);
          if (options.kind === 'work-board.v1' && options.coarseKind === 'work_board') {
            return { items: [{ ...artifacts.get('board-one')!, headerVersion: 1, bodyVersion: 1 }], coverage: 'complete' };
          }
          if (options.coarseKind === 'other') {
            const page = options.cursor ? Number(options.cursor) : 0;
            const start = page * 500;
            return { items: unrelatedOtherArtifacts.slice(start, start + 500), coverage: 'complete',
              ...(start + 500 < unrelatedOtherArtifacts.length ? { nextCursor: String(page + 1) } : {}) };
          }
          throw new Error('unscoped_artifact_list');
        },
        async read(artifactId, options) {
          readCalls.push({ artifactId, fresh: options?.fresh });
          return artifacts.get(artifactId) ?? null;
        },
        async readMany(artifactIds, options) {
          readManyCalls.push({ artifactIds, fresh: options?.fresh });
          return artifactIds.map(artifactId => artifacts.get(artifactId) ?? null);
        },
      },
      readSettings: async () => ({}),
      readProfileCatalog: async () => ({
        status: 'ready', records: [{ record: { v: 1, id: 'profile-one',
          definition: { kind: 'artifact', artifactId: 'profile-one' }, enabled: true,
          promptStack: [], skillSeeds: [], secretBindings: {} }, revision: 1 }],
        diagnostics: [], referenceGuardRevision: 'absent',
        authority: 'active', source: 'destination', control: null, controlRevision: 'absent',
      } as ProfileCatalogSnapshotV1),
      readPools: async () => ({ pools: [{
        pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Pool one', description: null,
          revision: 1, createdAt: 1, updatedAt: 1,
          members: [{ machineId, priorityTier: 0, enabled: true, state: 'connected' }] },
        availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
      }] } as MachinePoolListOutputV1),
      readAssignments: async () => { assignmentReads += 1; return { automations: [
        { id: 'workflow-assignment', name: 'Workflow assignment', description: null, enabled: true,
          workflowDefinitionId: 'workflow-definition', scopeSessionId: null, targetType: 'executionRun', existingSessionId: null,
          templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
          assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [] },
        { id: 'automation-assignment', name: 'Automation assignment', description: null, enabled: true,
          scopeSessionId: null, targetType: 'executionRun', existingSessionId: null,
          templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
          assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [] },
      ], nextCursor: null } as AutomationDefinitionListResponse; },
    };

    await expect(readMachineReferenceCensusV1({
      homeId: 'home', homeAliases: ['home-alias'], machineId,
    }, ports)).resolves.toEqual({
      homeId: 'home', machineId, coverage: 'partial', unavailable: ['profiles'], references: [
        { kind: 'board', id: 'board-one', name: 'Board one' },
        { kind: 'profile', id: 'profile-one', name: 'Profile one' },
        { kind: 'machine_pool', id: '00000000-0000-4000-8000-000000000001', name: 'Pool one' },
        { kind: 'workflow_assignment', id: 'workflow-assignment', name: 'Workflow assignment' },
        { kind: 'automation_assignment', id: 'automation-assignment', name: 'Automation assignment' },
      ],
    });
    expect(listCalls.map(({ kind, coarseKind, includeBody }) => ({ kind, coarseKind, includeBody }))).toEqual([
      { kind: 'work-board.v1', coarseKind: 'work_board', includeBody: undefined },
    ]);
    expect(readCalls).toEqual([{ artifactId: 'board-one', fresh: true }]);
    expect(readManyCalls).toEqual([{ artifactIds: ['profile-one'], fresh: true }]);
    expect(assignmentReads).toBe(1);
  });

  it('settles with partial coverage when its isolated Artifact detail read fails', async () => {
    const readCalls: { artifactId: string; fresh: boolean | undefined }[] = [];
    const result = await readMachineReferenceCensusV1({ homeId: 'home', machineId: 'machine-one' }, {
      artifacts: {
        list: async options => options.kind === 'work-board.v1'
          ? { items: [{ artifactId: 'unavailable-board', header: { kind: 'work-board.v1' }, headerVersion: 1,
              updatedAt: 1, ownerAccountId: 'account', access: 'owner' }], coverage: 'complete' }
          : { items: [], coverage: 'complete' },
        read: async (artifactId, options) => {
          readCalls.push({ artifactId, fresh: options?.fresh });
          throw new Error('artifact_content_unavailable');
        },
        readMany: async () => [],
      },
      readSettings: async () => ({}),
      readProfileCatalog: async () => ({
        status: 'ready', records: [], diagnostics: [], referenceGuardRevision: 'absent',
        authority: 'active', source: 'destination', control: null, controlRevision: 'absent',
      } as ProfileCatalogSnapshotV1),
      readPools: async () => ({ pools: [] }),
      readAssignments: async () => ({ automations: [], nextCursor: null }),
    });

    expect(result).toEqual({
      homeId: 'home', machineId: 'machine-one', coverage: 'partial', references: [], unavailable: ['artifacts', 'profiles'],
    });
    expect(readCalls).toEqual([{ artifactId: 'unavailable-board', fresh: true }]);
  });
});
