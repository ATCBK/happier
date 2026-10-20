import { describe, expect, it } from 'vitest';
import { DiscussionDocEditProposalContentV1Schema } from '@happier-dev/protocol/discussions/content';

import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { buildDiscussionTimelineItems, placeDiscussionRequesterApprovals, readDiscussionMessagePreview, resolveDiscussionMessageAuthorLabel, resolveDiscussionReplyAttributionLine, resolveDiscussionReplyOutcome } from '@/components/discussions/discussionTimelineProjection';
import { t } from '@/text';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

describe('readDiscussionMessagePreview', () => {
    it.each(['Clarify retries', ' \n '])('summarizes a proposal without before/after text: %j', (reason) => {
        const before = 'Private original passage';
        const content = DiscussionDocEditProposalContentV1Schema.parse({ kind: 'doc_edit_proposal', proposal: {
            target: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' },
                revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: before.length }, quote: before },
            baseRevision: { headerVersion: 1, bodyVersion: 1 }, before, after: 'Private replacement passage', reason,
        } });
        const title = t('artifacts.browser.proposal.title');
        expect(readDiscussionMessagePreview(content)).toBe(reason.trim() ? `${title} · ${reason}` : title);
    });

    it('preserves ordinary text and resolved mentions, and keeps unavailable content explicit', () => {
        expect(readDiscussionMessagePreview({ v: 1, parts: [
            { t: 'text', text: 'Ask ' }, { t: 'mention', participant: { kind: 'account', accountId: 'person' } },
        ] }, { account: () => 'Maya' })).toBe('Ask @Maya');
        expect(readDiscussionMessagePreview(null)).toBeNull();
    });
});

describe('resolveDiscussionMessageAuthorLabel', () => {
    it.each([
        [{ name: 'Maya Chen', username: 'maya' }, 'Maya Chen'],
        [{ name: '  ', username: 'maya' }, 'maya'],
        [null, t('accountDisplay.yours')],
    ] as const)('names the optimistic own message from the scoped viewer profile: %j', (profile, expected) => {
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: null, createdAt: 0 }, {
            accountId: 'viewer', profile,
        })).toBe(expected);
    });

    it('keeps historical and other Accounts distinct from the viewer', () => {
        const viewer = { accountId: 'viewer', profile: { name: 'Maya Chen' } };
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'other', accountActor: null, createdAt: 0 }, viewer))
            .toBe(t('session.collaboration.discussion.collaborator'));
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: { v: 1, accountId: 'viewer', profile: null }, createdAt: 1 }, viewer))
            .toBe(t('message.accountActorFormerMember'));
        expect(resolveDiscussionMessageAuthorLabel({ authorAccountId: 'viewer', accountActor: null, createdAt: 1 }, viewer))
            .toBe(t('session.collaboration.discussion.collaborator'));
    });
});

describe('resolveDiscussionReplyAttributionLine', () => {
    const persona = { serverId: 'home', sessionId: 'release-bot' };
    const viewer = { serverId: 'home', accountId: 'viewer' };
    const reply = (requesterAccountId: string | null, actor: { accountId: string; name: string } | null) => ({
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'release-bot', actionRequestAttributionV1: {
            requestRef: 'req-1', requester: requesterAccountId ? { serverId: 'home', accountId: requesterAccountId } : null, persona, origin: null } },
        requesterAccountActor: actor ? { v: 1 as const, accountId: actor.accountId, profile: { name: actor.name, firstName: null, lastName: null, username: null, avatarUrl: null } } : null,
    });

    it('names who asked and which Bot answered, from the stamped cause only', () => {
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'bob', name: 'Bob Keller' }), viewer, 'Release bot'))
            .toBe(t('session.collaboration.discussion.attribution.askedByAnsweredBy', { requester: 'Bob Keller', bot: 'Release bot' }));
        expect(resolveDiscussionReplyAttributionLine(reply('viewer', { accountId: 'viewer', name: 'Maya Chen' }), viewer, 'Release bot'))
            .toBe(t('session.collaboration.discussion.attribution.askedByAnsweredBy', { requester: t('session.collaboration.discussion.attribution.you'), bot: 'Release bot' }));
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'bob', name: 'Bob Keller' }), viewer, null))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: 'Bob Keller' }));
    });

    it('keeps an unprojected or mismatched requester unknown and says nothing without a person cause', () => {
        const other = t('session.collaboration.discussion.attribution.anotherPerson');
        expect(resolveDiscussionReplyAttributionLine(reply('bob', null), viewer, 'Release bot'))
            .toBe(t('session.collaboration.discussion.attribution.askedByAnsweredBy', { requester: other, bot: 'Release bot' }));
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'owner', name: 'Bot Owner' }), viewer, 'Release bot'))
            .toBe(t('session.collaboration.discussion.attribution.askedByAnsweredBy', { requester: other, bot: 'Release bot' }));
        expect(resolveDiscussionReplyAttributionLine(reply('viewer', null), { serverId: 'elsewhere', accountId: 'viewer' }, 'Release bot'))
            .toBe(t('session.collaboration.discussion.attribution.askedByAnsweredBy', { requester: other, bot: 'Release bot' }));
        expect(resolveDiscussionReplyAttributionLine(reply(null, null), viewer, 'Release bot')).toBeNull();
        expect(resolveDiscussionReplyAttributionLine({ producerV1: { v: 1, kind: 'agent', sessionId: 'release-bot' }, requesterAccountActor: null }, viewer, 'Release bot')).toBeNull();
        expect(resolveDiscussionReplyAttributionLine({ producerV1: null }, viewer, 'Release bot')).toBeNull();
    });
});

function workflowRun(id: string, params: Readonly<{ messageId: string; serverId?: string; discussionId?: string }>) {
    return createWorkflowRunSummaryFixture({ id, origin: { kind: 'direct', discussion: {
        discussion: { serverId: params.serverId ?? 'home-1', discussionId: params.discussionId ?? 'discussion-1' },
        messageId: params.messageId, throughSeq: 1,
    } } });
}

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
    serverId?: string;
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
                kind: 'discussion',
                serverId: params.serverId ?? 'home-1',
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

describe('resolveDiscussionReplyOutcome', () => {
    const reply = (outcome?: 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result') => ({
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'checkout-ui',
            ...(outcome ? { replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome } } : {}) },
    });

    it('reads how an addressed participant answered from the stamped return, and says nothing for other messages', () => {
        expect(resolveDiscussionReplyOutcome(reply('answer'))).toBe('answer');
        expect(resolveDiscussionReplyOutcome(reply('pass'))).toBe('pass');
        // Ending without a result is a failed answer to the person who asked, not a quiet pass.
        expect(resolveDiscussionReplyOutcome(reply('failed'))).toBe('failed');
        expect(resolveDiscussionReplyOutcome(reply('terminal_no_result'))).toBe('failed');
        expect(resolveDiscussionReplyOutcome(reply('cancelled'))).toBe('cancelled');
        // An agent posting on its own (no addressed question) and a person's message carry no outcome.
        expect(resolveDiscussionReplyOutcome(reply())).toBeNull();
        expect(resolveDiscussionReplyOutcome({ producerV1: null })).toBeNull();
    });
});

describe('buildDiscussionTimelineItems', () => {
    it('anchors linked runs after the highest selected message and orders equal anchors by canonical start then run id', () => {
        const entries = new Map([
            ['run-z', entry('run-z', 20)],
            ['run-b', entry('run-b', 10)],
            ['run-a', entry('run-a', 10)],
        ]);

        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2), message('message-3', 3)],
            subagents: [
                run({ runId: 'run-z', messageIds: ['message-1', 'message-3'] }),
                run({ runId: 'run-b', messageIds: ['message-2'] }),
                run({ runId: 'run-a', messageIds: ['message-2'] }),
            ],
            readExecutionRunEntry: (runId) => entries.get(runId) ?? null,
        });

        expect(items.map((item) => {
            switch (item.kind) {
                case 'human_message': return `message:${item.message.id}`;
                case 'agent_activity_reference': return `run:${item.entry.runId}@${item.anchorSeq}`;
                case 'workflow_run': return `workflow:${item.run.id}`;
            }
        })).toEqual([
            'message:message-1',
            'message:message-2',
            'run:run-a@2',
            'run:run-b@2',
            'message:message-3',
            'run:run-z@3',
        ]);
    });

    it('ignores another Home with the same raw Discussion ID and unresolved or non-canonical run sources', () => {
        const validEntry = entry('run-valid', 10);
        const wrongKindEntry = { ...entry('run-not-execution', 11), kind: 'subagent' as const };
        const malformed = {
            ...run({ runId: 'run-malformed' }),
            runRef: {
                runId: 'run-malformed',
                launchOrigin: { kind: 'discussion', serverId: 'home-1' },
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

        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1)],
            subagents: [
                run({ runId: 'run-valid' }),
                run({ runId: 'run-not-execution' }),
                run({ runId: 'run-cross-session', serverId: 'home-2' }),
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

    it('places each managed Pattern run right after the exact message that started it, on this Discussion and Home only', () => {
        const items = buildDiscussionTimelineItems({
            serverId: 'home-1',
            discussionId: 'discussion-1',
            messages: [message('message-1', 1), message('message-2', 2), message('message-3', 3)],
            subagents: [],
            readExecutionRunEntry: () => null,
            workflowRuns: [
                workflowRun('wf-later', { messageId: 'message-2' }),
                workflowRun('wf-first', { messageId: 'message-1' }),
                workflowRun('wf-other-home', { messageId: 'message-1', serverId: 'home-2' }),
                workflowRun('wf-other-discussion', { messageId: 'message-1', discussionId: 'discussion-2' }),
                workflowRun('wf-unloaded', { messageId: 'message-0' }),
                { ...workflowRun('wf-no-origin', { messageId: 'message-1' }), origin: { kind: 'direct' as const } },
            ],
        });

        expect(items.map((item) => item.kind === 'human_message' ? item.message.id
            : item.kind === 'workflow_run' ? `run:${item.run.id}` : 'reference')).toEqual([
            'message-1', 'run:wf-first', 'message-2', 'run:wf-later', 'message-3',
        ]);
    });

});

describe('placeDiscussionRequesterApprovals', () => {
    const persona = { serverId: 'home', sessionId: 'release-bot' };
    const ask = { id: 'ask', producerV1: null };
    const botReply = (id: string, requestRef: string, outcome?: 'answer' | 'pass') => ({ id, producerV1: {
        v: 1 as const, kind: 'agent' as const, sessionId: 'release-bot',
        ...(outcome ? { replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome } } : {}),
        actionRequestAttributionV1: { requestRef, requester: { serverId: 'home', accountId: 'bob' }, persona, origin: null } } });
    const approval = { id: 'approval-1', requestRef: 'req-1', originMessageId: 'ask' };

    it('reads under the Bot reply that answered the same admitted ask', () => {
        const placed = placeDiscussionRequesterApprovals([ask, botReply('other', 'req-2'), botReply('reply', 'req-1', 'answer')], [approval]);
        expect([...placed.entries()]).toEqual([['reply', [approval]]]);
    });

    it('reads under the message that asked while the Bot has not replied, or replied with a one-line outcome', () => {
        expect([...placeDiscussionRequesterApprovals([ask], [approval]).entries()]).toEqual([['ask', [approval]]]);
        expect([...placeDiscussionRequesterApprovals([ask, botReply('passed', 'req-1', 'pass')], [approval]).entries()]).toEqual([['ask', [approval]]]);
    });

    it('places nothing whose message is not loaded in this thread', () => {
        expect(placeDiscussionRequesterApprovals([botReply('other', 'req-2')], [approval]).size).toBe(0);
    });
});
