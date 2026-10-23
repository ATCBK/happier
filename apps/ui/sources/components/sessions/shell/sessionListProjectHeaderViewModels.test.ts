import { describe, expect, it, vi } from 'vitest';
import * as workspaceDisplay from '@/sync/domains/workspaces/workspaceDisplayPresentation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { t } from '@/text';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { buildSessionListProjectHeaderViewModels } from './sessionListProjectHeaderViewModels';

describe('buildSessionListProjectHeaderViewModels', () => {
    it('does not retain a full Session list in the bounded header projection cache', async () => {
        const { Session: InspectorSession } = await import('node:inspector');
        const list = (() => {
            const listItems: SessionListIndexItem[] = [
                { type: 'session', serverId: 'header-retention-home', sessionId: 'header-retention-row' },
                { type: 'header', headerKind: 'project', groupKey: 'header-retention-group', title: '/retention' },
            ];
            buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs: [], workspaceLabels: {} });
            return new WeakRef(listItems);
        })();
        const inspector = new InspectorSession();
        inspector.connect();
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
            expect(list.deref(), 'header labels must not retain the full Session list').toBeUndefined();
        } finally { inspector.disconnect(); }
    });
    it('updates the affected name-collision group and preserves locked and unlisted naming', () => {
        const machines = ['a', 'b', 'c'].map(id => createMachineFixture({ id,
            metadata: { ...createMachineFixture().metadata!, host: `build-${id}`, displayName: id === 'c' ? 'Other' : 'Build' } }));
        const input = { listItems: machines.map(machine => ({ type: 'header' as const, headerKind: 'project' as const,
            groupKey: machine.id, title: '/repo', workspaceScopeHint: { serverId: 'collision-home', machineId: machine.id, rootPath: '/repo' } })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])), workspaceRefs: [], workspaceLabels: {} };
        const first = buildSessionListProjectHeaderViewModels(input);
        expect(first.projectHeaderViewModelByGroupKey.get('b')?.machineSubtitle).toBe('Build · build-b');
        input.machinesById.set('a', { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Renamed' } });
        const renamed = buildSessionListProjectHeaderViewModels(input);
        expect(renamed.projectHeaderViewModelByGroupKey.get('b')?.machineSubtitle).toBe('Build');
        expect(renamed.projectHeaderViewModelByGroupKey.get('c')).toBe(first.projectHeaderViewModelByGroupKey.get('c'));
        input.machinesById.set('a', { ...machines[0]!, metadata: null, availability: { kind: 'locked', reason: 'decryption_failed' } });
        expect(buildSessionListProjectHeaderViewModels(input).projectHeaderViewModelByGroupKey.get('a')?.machineSubtitle)
            .toBe(t('machine.lockedMachine'));
        input.machinesById.delete('a');
        expect(buildSessionListProjectHeaderViewModels(input).projectHeaderViewModelByGroupKey.get('a')?.machineSubtitle)
            .toBe(t('machine.unlistedMachine'));
    });
    it('changes only the addressed header subtitle without rederiving workspace presentations', () => {
        const machines = Array.from({ length: 20 }, (_, i) => createMachineFixture({ id: `header-machine-${i}`,
            metadata: { ...createMachineFixture().metadata!, displayName: `Machine ${i}` } }));
        const input = { listItems: machines.map(machine => ({ type: 'header' as const, headerKind: 'project' as const,
            groupKey: machine.id, title: '/repo', workspaceScopeHint: { serverId: 'header-home', machineId: machine.id, rootPath: '/repo' } })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])), workspaceRefs: [], workspaceLabels: {} };
        const before = buildSessionListProjectHeaderViewModels(input);
        const derive = vi.spyOn(workspaceDisplay, 'resolveWorkspaceDisplayPresentation');
        try {
            input.machinesById.set(machines[0]!.id, { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Renamed' } });
            const after = buildSessionListProjectHeaderViewModels(input);
            expect(after.projectHeaderViewModelByGroupKey.get(machines[0]!.id)?.machineSubtitle).toBe('Renamed');
            expect(derive).not.toHaveBeenCalled();
            expect(after.projectHeaderViewModelByGroupKey.get(machines[1]!.id)).toBe(before.projectHeaderViewModelByGroupKey.get(machines[1]!.id));
        } finally { derive.mockRestore(); }
    });
    it('keeps the project path when hydration omits the redundant scope hint', () => {
        const project = { t: 'workspaceScope' as const, serverId: 'stable-home', machineId: 'stable-machine', rootPath: '/home/ubuntu/release' };
        const input = { listItems: [{ type: 'header' as const, headerKind: 'project' as const,
            groupKey: 'stable-project', title: 'No folder', workspace: project }], workspaceRefs: [], workspaceLabels: {} };
        const first = buildSessionListProjectHeaderViewModels(input);
        expect(first.projectHeaderViewModelByGroupKey.get('stable-project')?.displayTitle).toBe('release');
        const moved = buildSessionListProjectHeaderViewModels({ ...input,
            listItems: [{ ...input.listItems[0]!, workspace: { ...project, rootPath: '/home/ubuntu/another' } }] });
        expect(moved.projectHeaderViewModelByGroupKey.get('stable-project')?.displayTitle).toBe('another');
    });
    it('keeps the Chats identity despite an inherited legacy workspace label', () => {
        const inheritedLabel = buildSessionListProjectHeaderViewModels({
            listItems: [{
                type: 'header', title: 'Chats', headerKind: 'project',
                groupKey: 'managed-chats', workspaceKey: 'managed-label',
            }],
            workspaceRefs: [],
            workspaceLabels: { 'managed-label': 'Old custom label' },
        });
        expect(inheritedLabel.projectHeaderViewModelByGroupKey.get('managed-chats')?.displayTitle).toBe('Old custom label');
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [{
                type: 'header', title: 'Chats', headerKind: 'project',
                groupKey: 'managed-chats', workspaceKey: 'managed-label',
                workspace: { t: 'managedSessions', serverId: 'server-a', machineId: 'machine-a' },
            }],
            workspaceRefs: [],
            workspaceLabels: { 'managed-label': 'Old custom label' },
        });
        expect(result.projectHeaderViewModelByGroupKey.get('managed-chats')).toMatchObject({
            displayTitle: 'Chats', hasCustomLabel: false, workspaceRefId: null, scopeHint: null,
        });
    });
    it('reuses a shared empty state when there are no project headers', () => {
        const first = buildSessionListProjectHeaderViewModels({
            listItems: [],
            workspaceRefs: [],
            workspaceLabels: {},
        });
        const second = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: 'server:server-a:day:2026-02-19',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {},
        });

        expect(first).toBe(second);
        expect(first.projectHeaderViewModelByGroupKey).toBe(second.projectHeaderViewModelByGroupKey);
        expect(first.scopeHintByLegacyWorkspaceKey).toBe(second.scopeHintByLegacyWorkspaceKey);
        expect(first.projectHeaderViewModelByGroupKey.size).toBe(0);
        expect(first.scopeHintByLegacyWorkspaceKey.size).toBe(0);
    });

    it('indexes project header display state and legacy scope hints from canonical workspace refs', () => {
        const scopeHint = {
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: '/repo',
        };

        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: scopeHint,
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [
                {
                    id: 'wr_1',
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                    label: 'Important Repo',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            workspaceLabels: {},
        });

        expect(result.scopeHintByLegacyWorkspaceKey.get('legacy_repo')).toEqual(scopeHint);
        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Important Repo',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint,
            workspaceRefId: 'wr_1',
        });
    });

    it('falls back to legacy labels when no canonical workspace scope hint exists', () => {
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {
                legacy_repo: 'Legacy Label',
            },
        });

        expect(result.scopeHintByLegacyWorkspaceKey.size).toBe(0);
        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Legacy Label',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint: null,
            workspaceRefId: null,
        });
    });

    it('uses the workspace basename for unlabeled project headers by default', () => {
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '~/Documents/Development/happier/remote-dev',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/Users/lee/Documents/Development/happier/remote-dev',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {},
        });

        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            displayTitle: 'remote-dev',
            hasCustomLabel: false,
        });
    });

    it('reuses the same project-header state for identical non-empty inputs', () => {
        const listItems = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'project:repo',
                workspaceKey: 'legacy_repo',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ] as any;

        const workspaceRefs = [
            {
                id: 'wr_1',
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
                label: 'Important Repo',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const first = buildSessionListProjectHeaderViewModels({
            listItems,
            workspaceRefs,
            workspaceLabels: {},
        });
        const second = buildSessionListProjectHeaderViewModels({
            listItems: [...listItems],
            workspaceRefs: [...workspaceRefs],
            workspaceLabels: {},
        });

        expect(first).toBe(second);
        expect(first.projectHeaderViewModelByGroupKey).toBe(second.projectHeaderViewModelByGroupKey);
        expect(first.scopeHintByLegacyWorkspaceKey).toBe(second.scopeHintByLegacyWorkspaceKey);
        expect(first.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Important Repo',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy_repo',
            workspaceRefId: 'wr_1',
        });
    });
});
