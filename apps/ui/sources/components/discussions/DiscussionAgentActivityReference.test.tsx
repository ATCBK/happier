import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { DiscussionAgentActivityReference } from '@/components/discussions/DiscussionAgentActivityReference';

const entry: AgentActivityEntry = {
    id: 'execution_run:run-linked',
    kind: 'execution_run',
    status: 'running',
    title: 'Review authentication',
    metaDetail: null,
    startedAtMs: 10,
    endedAtMs: null,
    provenance: 'local',
    detailState: 'loaded',
    parentId: null,
    runId: 'run-linked',
    sidechainId: null,
    subagentId: 'execution_run:run-linked',
    attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
};

const subagent: SessionSubagent = {
    id: 'execution_run:run-linked',
    kind: 'execution_run',
    status: 'running',
    display: { title: 'Review authentication' },
    transcript: {},
    runRef: { runId: 'run-linked', intent: 'review' },
    recipient: null,
    capabilities: {
        canOpen: true,
        canSend: false,
        canStop: false,
        canLaunchChild: false,
        canDelete: false,
        canOpenAdvancedRun: true,
    },
    timestamps: {},
};

describe('DiscussionAgentActivityReference', () => {
    it('renders the shared Agent activity presentation and delegates opening to its host', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <DiscussionAgentActivityReference entry={entry} subagent={subagent} onPress={onPress} />,
        );

        expect(screen.getTextContent()).toContain('Review authentication');
        expect(screen.findByTestId('session-discussion-agent-activity-summary:run-linked')).toBeTruthy();

        screen.pressByTestId('session-discussion-agent-activity:run-linked');
        expect(onPress).toHaveBeenCalledOnce();
    });
});
