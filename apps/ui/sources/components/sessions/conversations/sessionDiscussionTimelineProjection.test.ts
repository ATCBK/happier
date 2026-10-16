import { describe, expect, it } from 'vitest';

import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { buildSessionDiscussionTimelineItems, resolveSessionDiscussionMessageAuthorLabel } from './sessionDiscussionTimelineProjection';
import { t } from '@/text';

describe('resolveSessionDiscussionMessageAuthorLabel', () => {
    it.each([
        [{ name: 'Maya Chen', username: 'maya' }, 'Maya Chen'],
        [{ name: '  ', username: 'maya' }, 'maya'],
        [null, t('accountDisplay.yours')],
    ] as const)('names the optimistic own message from the scoped viewer profile: %j', (profile, expected) => {
        expect(resolveSessionDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: null, createdAt: 0 }, {
            accountId: 'viewer', profile,
        })).toBe(expected);
    });

    it('keeps historical and other Accounts distinct from the viewer', () => {
        const viewer = { accountId: 'viewer', profile: { name: 'Maya Chen' } };
        expect(resolveSessionDiscussionMessageAuthorLabel({ authorAccountId: 'other', accountActor: null, createdAt: 0 }, viewer))
            .toBe(t('session.collaboration.discussion.collaborator'));
        expect(resolveSessionDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: { v: 1, accountId: 'viewer', profile: null }, createdAt: 1 }, viewer))
            .toBe(t('message.accountActorFormerMember'));
        expect(resolveSessionDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: null, createdAt: 1 }, viewer))
            .toBe(t('session.collaboration.discussion.collaborator'));
    });
});

function message(id: string, seq: number) {
    return { id, seq };
}

function entry(runId: string, startedAtMs: number | null): AgentActivityEntry {
    return {
        id: `execution_run:${runId}`,
        kind: 'execution_run',
        status: 'running',
        title: runId,
        metaDetail: null,
        startedAtMs,
        endedAtMs: null,
        provenance: 'local',
        detailState: 'loaded',
        parentId: null,
        runId,
        sidechainId: null,
        subagentId: `execution_run:${runId}`,
        attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    };
}

function run(params: Readonly<{
    runId: string;
    sessionId?: string;
    discussionId?: string;
    messageIds?: readonly string[];
}>): SessionSubagent {
    return {
        id: `execution_run:${params.runId}`,
        kind: 'execution_run',
        status: 'running',
        display: { title: params.runId },
        transcript: {},
        runRef: {
            runId: params.runId,
            launchOrigin: {
                kind: 'session_discussion',
                sessionId: params.sessionId ?? 'session-1',
                discussionId: params.discussionId ?? 'discussion-1',
                messageIds: [...(params.messageIds ?? ['message-1'])],
            },
        },
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
}

describe('buildSessionDiscussionTimelineItems', () => {
    it('anchors linked runs after the highest selected message and orders equal anchors by canonical start then run id', () => {
        const entries = new Map([
            ['run-z', entry('run-z', 20)],
            ['run-b', entry('run-b', 10)],
            ['run-a', entry('run-a', 10)],
        ]);

        const items = buildSessionDiscussionTimelineItems({
            sessionId: 'session-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2), message('message-3', 3)],
            subagents: [
                run({ runId: 'run-z', messageIds: ['message-1', 'message-3'] }),
                run({ runId: 'run-b', messageIds: ['message-2'] }),
                run({ runId: 'run-a', messageIds: ['message-2'] }),
            ],
            readExecutionRunEntry: (runId) => entries.get(runId) ?? null,
        });

        expect(items.map((item) => item.kind === 'human_message'
            ? `message:${item.message.id}`
            : `run:${item.entry.runId}@${item.anchorSeq}`)).toEqual([
            'message:message-1',
            'message:message-2',
            'run:run-a@2',
            'run:run-b@2',
            'message:message-3',
            'run:run-z@3',
        ]);
    });

    it('ignores cross-session, other-discussion, unresolved-message, malformed, and non-canonical run sources', () => {
        const validEntry = entry('run-valid', 10);
        const wrongKindEntry = { ...entry('run-not-execution', 11), kind: 'subagent' as const };
        const malformed = {
            ...run({ runId: 'run-malformed' }),
            runRef: {
                runId: 'run-malformed',
                launchOrigin: { kind: 'session_discussion', sessionId: 'session-1' },
            },
        } as unknown as SessionSubagent;

        const entries = new Map<string, AgentActivityEntry>([
            ['run-valid', validEntry],
            ['run-not-execution', wrongKindEntry],
            ['run-cross-session', entry('run-cross-session', 12)],
            ['run-other-discussion', entry('run-other-discussion', 13)],
            ['run-unresolved', entry('run-unresolved', 14)],
            ['run-malformed', entry('run-malformed', 15)],
        ]);

        const items = buildSessionDiscussionTimelineItems({
            sessionId: 'session-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1)],
            subagents: [
                run({ runId: 'run-valid' }),
                run({ runId: 'run-not-execution' }),
                run({ runId: 'run-cross-session', sessionId: 'session-2' }),
                run({ runId: 'run-other-discussion', discussionId: 'discussion-2' }),
                run({ runId: 'run-unresolved', messageIds: ['missing-message'] }),
                malformed,
            ],
            readExecutionRunEntry: (runId) => entries.get(runId) ?? null,
        });

        expect(items).toHaveLength(2);
        expect(items[1]).toMatchObject({
            kind: 'agent_activity_reference',
            anchorSeq: 1,
            entry: { runId: 'run-valid' },
        });
    });

});
