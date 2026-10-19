import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderProviderSessionDetailsTab } from './sessionSubagentUiBehavior';

vi.mock('./agentUiBehavior/AgentInlineSurface', () => ({
    AgentInlineSurface: () => null,
}));

vi.mock('@/sync/domains/session/readSessionOwnerMetadataView', () => ({
    readSessionOwnerMetadataView: () => ({}),
}));

vi.mock('@/agents/registry/registryUiBehavior', () => ({
    resolveAgentUiBehaviorFromSessionMetadata: () => ({
        sessionSubagents: {
            renderLaunchCards: ({ renderInlineSurface }: Readonly<{
                renderInlineSurface: (surface: Readonly<{
                    slotId: string;
                    pluginId: string;
                    surfaceId: string;
                    sessionId: string;
                    agentId: string;
                }>) => React.ReactNode;
            }>) => [renderInlineSurface({
                slotId: 'fixture.launch-card',
                pluginId: 'happier.agent.fixture',
                surfaceId: 'subagent-launch',
                sessionId: 'duplicate-session-id',
                agentId: 'happier.agent.fixture',
            })],
        },
    }),
}));

describe('renderProviderSessionDetailsTab', () => {
    it('presents an Agent launch tab through its launch surface with the teams it may join', () => {
        const node = renderProviderSessionDetailsTab({
            sessionId: 's1',
            scopeId: 'session:s1',
            serverId: 'server-a',
            tab: {
                key: 'fixture-launcher:launch',
                kind: 'fixtureLauncher',
                title: 'Launch teammate',
                resource: {
                    kind: 'fixtureLauncher',
                    mode: 'launch',
                    pluginInlineSurface: { pluginId: 'happier.agent.fixture', agentId: 'fixture', surfaceId: 'subagent-launch' },
                    teamIds: ['qa-team'],
                },
            } as any,
        });
        // The surface is `content`: the Details tab hosts it inside the frame that owns its gutters.
        if (!React.isValidElement<Readonly<{ children: React.ReactNode }>>(node)) throw new Error('expected the launch frame');
        const surface = React.Children.only(node.props.children);
        if (!React.isValidElement<Readonly<{ inlineMount: unknown; launchInput: unknown; surfaceId: string }>>(surface)) {
            throw new Error('expected the launch surface');
        }
        expect(surface.props.surfaceId).toBe('subagent-launch');
        expect(surface.props.inlineMount).toEqual({ role: 'sessionSubagentLaunch', presentation: 'content' });
        expect(surface.props.launchInput).toEqual({ teamIds: ['qa-team'] });
    });
});
