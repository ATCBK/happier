import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createSessionAgentActivityRowForTest, installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSubagentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Pressable', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string, values?: Record<string, unknown>) => {
            if (key === 'sessionAgentActivity.roster.teamLabel' && typeof values?.count === 'number') {
                return `Team ${String(values.team)} · ${values.count} agents`;
            }
            return key;
        } });
    },
});

vi.mock('@/components/sessions/agents/list/SessionSubagentRow', () => ({
    SessionSubagentRow: (props: { row: { subagent: SessionSubagent } }) => React.createElement('SessionSubagentRow', { testID: `row:${props.row.subagent.id}` }),
}));

describe('SessionSubagentGroup', () => {
    it('withholds team shutdown without an exact Home', async () => {
        const { SessionSubagentGroup } = await import('./SessionSubagentGroup');

        const subagents: readonly SessionSubagent[] = [{
            id: 'agent_team_member:qa-team:alpha',
            kind: 'agent_team_member',
            status: 'running',
            display: {
                title: 'alpha',
                providerLabel: 'Claude',
                groupKey: 'qa-team',
                groupLabel: 'qa-team',
            },
            transcript: { toolId: 'toolu_1', toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1' },
            recipient: {
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
            capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
            timestamps: {},
        }];

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentGroup
                    sessionId="s1"
                    label="qa-team"
                    rows={subagents.map((subagent) => createSessionAgentActivityRowForTest(subagent))}
                    activityPreviewById={new Map()}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />)).tree;

        // Team operations live in the team's quiet menu, not as buttons on its label (lab AG1).
        expect(tree!.findAllByProps({ testID: 'session-subagent-team-actions:qa-team' })).toEqual([]);
    });

    it('renders a group count alongside the group label', async () => {
        const { SessionSubagentGroup } = await import('./SessionSubagentGroup');

        const subagents: readonly SessionSubagent[] = [
            {
                id: 'agent_team_member:qa-team:alpha',
                kind: 'agent_team_member',
                status: 'running',
                display: { title: 'alpha', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
                transcript: { toolId: 'toolu_1', toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1' },
                recipient: {
                    kind: 'agent_team_member',
                    teamId: 'qa-team',
                    memberId: 'alpha@qa-team',
                    memberLabel: 'alpha',
                },
                capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
                timestamps: {},
            },
            {
                id: 'agent_team_member:qa-team:beta',
                kind: 'agent_team_member',
                status: 'running',
                display: { title: 'beta', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
                transcript: { toolId: 'toolu_2', toolMessageRouteId: 'tool-msg-2', sidechainId: 'toolu_2' },
                recipient: {
                    kind: 'agent_team_member',
                    teamId: 'qa-team',
                    memberId: 'beta@qa-team',
                    memberLabel: 'beta',
                },
                capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
                timestamps: {},
            },
        ];

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentGroup
                    sessionId="s1"
                    label="qa-team"
                    rows={subagents.map((subagent) => createSessionAgentActivityRowForTest(subagent))}
                    activityPreviewById={new Map()}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />)).tree;

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('Team qa-team · 2 agents');
    });

    it('can request launching a teammate for an existing Claude team group', async () => {
        const { SessionSubagentGroup } = await import('./SessionSubagentGroup');
        const launchTeammateSpy = vi.fn();

        const subagents: readonly SessionSubagent[] = [{
            id: 'agent_team_member:qa-team:alpha',
            kind: 'agent_team_member',
            status: 'running',
            display: { title: 'alpha', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
            transcript: { toolId: 'toolu_1', toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1' },
            recipient: {
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
            capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
            timestamps: {},
        }];

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionSubagentGroup
                    sessionId="s1"
                    label="qa-team"
                    rows={subagents.map((subagent) => createSessionAgentActivityRowForTest(subagent))}
                    activityPreviewById={new Map()}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                    onLaunchTeammate={launchTeammateSpy}
                />)).tree;

        const [menu] = tree!.findAllByProps({ testID: 'session-subagent-team-actions:qa-team' });
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['add-teammate']);

        await act(async () => {
            menu.props.onSelect('add-teammate');
        });

        expect(launchTeammateSpy).toHaveBeenCalledWith('qa-team');
    });
});
