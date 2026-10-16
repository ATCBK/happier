import { describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import {
    findSessionServerStartCandidateForDirectory,
    presentSessionServerStartCandidate,
    resolveSessionServerStartCandidateSelection,
} from './serverStartDraftCandidateSelection';

describe('Session server-start candidate selection', () => {
    it('uses settled exact-machine absence for both candidate readiness and its machine caption', () => {
        const stale = createMachineFixture({ id: 'machine-gone', active: true, activeAt: Date.now() });
        const other = createMachineFixture({ id: 'machine-other' });
        const candidate = { projectKey: { id: 'project-gone' }, serverId: 'server-a', machineId: stale.id,
            rootPath: '/repo', reachable: true, worktrees: [] };
        const context = { activeServerId: 'server-a', activeMachines: [stale],
            machineListByServerId: { 'server-a': [other] }, machineListStatusByServerId: { 'server-a': 'idle' as const } };
        expect(resolveSessionServerStartCandidateSelection({ mountedTarget: candidate, ...context })).toMatchObject({
            machine: null, machineReady: false,
        });
        expect(presentSessionServerStartCandidate({ candidate, ...context })).toEqual({ title: '/repo', subtitle: undefined });
    });

    it('keeps the selected server, machine, path, and readiness on one candidate', () => {
        const mountedMachine = createMachineFixture({
            id: 'shared-machine-id',
            active: false,
            activeAt: 0,
        });
        const selectedMachine = createMachineFixture({
            id: 'shared-machine-id',
            active: true,
            activeAt: Date.now(),
            metadata: {
                host: 'selected.example',
                platform: 'darwin',
                happyCliVersion: '1.0.0',
                happyHomeDir: '/selected/.happier',
                homeDir: '/selected',
            },
        });
        const candidate = {
            projectKey: { id: 'project-selected' },
            serverId: 'server-selected',
            machineId: 'shared-machine-id',
            rootPath: '/selected/project',
            reachable: true,
            worktrees: [],
        };

        const selection = resolveSessionServerStartCandidateSelection({
            accountScope: { serverId: 'server-selected', accountId: 'selected-account' },
            mountedTarget: { serverId: 'server-mounted', machineId: 'shared-machine-id' },
            selectedCandidate: candidate,
            activeServerId: 'server-mounted',
            activeMachines: [mountedMachine],
            machineListByServerId: { 'server-selected': [selectedMachine] },
        });

        expect(selection).toEqual({
            candidate,
            target: { serverId: 'server-selected', machineId: 'shared-machine-id' },
            machine: selectedMachine,
            directory: '/selected/project',
            machineReady: true,
        });
    });

    it('presents a placement candidate by its home-relative folder and machine name, never raw ids', () => {
        const machine = createMachineFixture({
            id: 'machine-id-1',
            metadata: {
                host: 'studio.local',
                platform: 'darwin',
                happyCliVersion: '1.0.0',
                happyHomeDir: '/Users/ada/.happier',
                homeDir: '/Users/ada',
                displayName: 'Studio',
            },
        });
        const candidate = {
            projectKey: { id: 'project-1' },
            serverId: 'server-1',
            machineId: 'machine-id-1',
            rootPath: '/Users/ada/code/app',
            reachable: true,
            worktrees: [],
        };
        const context = { activeServerId: 'server-1', activeMachines: [machine], machineListByServerId: {} };

        expect(presentSessionServerStartCandidate({ candidate, ...context })).toEqual({
            title: '~/code/app',
            subtitle: 'Studio',
        });
        expect(presentSessionServerStartCandidate({ candidate: { ...candidate, label: 'App' }, ...context }).title).toBe('App');
        // A machine this device cannot see is not named by its id.
        expect(presentSessionServerStartCandidate({
            candidate: { ...candidate, machineId: 'unknown-machine' },
            ...context,
        })).toEqual({ title: '/Users/ada/code/app', subtitle: undefined });
    });

    it('marks as selected only the candidate on the chosen machine whose folder is the edited directory', () => {
        const primary = { projectKey: { id: 'project-primary' }, serverId: 'server-a', machineId: 'machine-1',
            rootPath: '/work/app', reachable: true, worktrees: [] };
        const worktree = { projectKey: { id: 'project-worktree' }, serverId: 'server-a', machineId: 'machine-1',
            rootPath: '/work/app-review', reachable: true, worktrees: [] };
        const elsewhere = { projectKey: { id: 'project-elsewhere' }, serverId: 'server-b', machineId: 'machine-1',
            rootPath: '/work/app', reachable: true, worktrees: [] };
        const candidates = [primary, worktree, elsewhere];
        const target = { serverId: 'server-a', machineId: 'machine-1' };

        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '/work/app' })).toBe(0);
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: ' /work/app-review/ ' })).toBe(1);
        // A typed folder no candidate stands for selects none, and the sibling-prefix path is not the candidate.
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '/work/app-other' })).toBe(-1);
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '/work/app/sub' })).toBe(-1);
        expect(findSessionServerStartCandidateForDirectory({ candidates, target, directory: '' })).toBe(-1);
        // The same folder on another Home is another candidate, not this one.
        expect(findSessionServerStartCandidateForDirectory({
            candidates, target: { serverId: 'server-b', machineId: 'machine-1' }, directory: '/work/app',
        })).toBe(2);
        expect(findSessionServerStartCandidateForDirectory({ candidates: undefined, target, directory: '/work/app' })).toBe(-1);
    });
});
