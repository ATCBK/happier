import { describe, expect, it } from 'vitest';

import { buildSessionListProjectHeaderViewModels } from './sessionListProjectHeaderViewModels';

describe('buildSessionListProjectHeaderViewModels', () => {
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
