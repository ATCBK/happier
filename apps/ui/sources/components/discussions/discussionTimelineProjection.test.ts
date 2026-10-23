import { describe, expect, it } from 'vitest';
import { DiscussionDocEditProposalContentV1Schema, DiscussionMessageContentV1Schema, DiscussionProducerV1Schema } from '@happier-dev/protocol/discussions/content';

import {
    NO_SESSION_AGENT_ACTIVITY_ATTENTION,
    type AgentActivityEntry,
} from '@/sync/domains/session/agentActivity';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { buildDiscussionTimelineItems, placeDiscussionRequesterApprovals, readDiscussionMessagePreview, resolveDiscussionMessageAuthorLabel, resolveDiscussionReplyAttributionLine, resolveDiscussionReplyOutcome, resolveDiscussionWorkflowAttribution, readDiscussionWorkflowResultDetail, resolveDiscussionReplyPresentation, startsDiscussionMessageGroup } from '@/components/discussions/discussionTimelineProjection';
import { t } from '@/text';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

describe('readDiscussionMessagePreview', () => {
    it('keeps lookalike inline tokens as labels alongside typed Discussion mentions', () => {
        expect(readDiscussionMessagePreview({ v: 1, parts: [
            { t: 'text', text: 'Ask [lookalike](happier-ref:session:unowned) and ' },
            { t: 'mention', participant: { kind: 'session', sessionId: 's1' } },
        ] }, { session: () => 'Auth fix' })).toBe('Ask lookalike and @Auth fix');
    });

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

    it('names who asked, from the stamped cause only (the row already names the agent)', () => {
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'bob', name: 'Bob Keller' }), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: 'Bob Keller' }));
        expect(resolveDiscussionReplyAttributionLine(reply('viewer', { accountId: 'viewer', name: 'Maya Chen' }), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: t('session.collaboration.discussion.attribution.you') }));
    });

    it.each([
        ['former member', { v: 1 as const, accountId: 'bob', profile: null }, t('message.accountActorFormerMember')],
        ['unknown requester', null, t('session.collaboration.discussion.attribution.anotherPerson')],
        ['current member', reply('bob', { accountId: 'bob', name: 'Bob Keller' }).requesterAccountActor, 'Bob Keller'],
        ['unnamed current member', reply('bob', { accountId: 'bob', name: '  ' }).requesterAccountActor, t('message.accountActorUnnamedMember')],
    ] as const)('distinguishes the %s in the admitted requester projection', (_case, requesterAccountActor, name) => {
        expect(resolveDiscussionReplyAttributionLine({ ...reply('bob', null), requesterAccountActor }, viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: name }));
    });

    it('keeps an unprojected or mismatched requester unknown and says nothing without a person cause', () => {
        const other = t('session.collaboration.discussion.attribution.anotherPerson');
        expect(resolveDiscussionReplyAttributionLine(reply('bob', null), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine(reply('bob', { accountId: 'owner', name: 'Bot Owner' }), viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine({ ...reply('bob', null),
            requesterAccountActor: { v: 1, accountId: 'owner', profile: null } }, viewer))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine(reply('viewer', null), { serverId: 'elsewhere', accountId: 'viewer' }))
            .toBe(t('session.collaboration.discussion.attribution.askedBy', { requester: other }));
        expect(resolveDiscussionReplyAttributionLine(reply(null, null), viewer)).toBeNull();
        expect(resolveDiscussionReplyAttributionLine({ producerV1: { v: 1, kind: 'agent', sessionId: 'release-bot' }, requesterAccountActor: null }, viewer)).toBeNull();
        expect(resolveDiscussionReplyAttributionLine({ producerV1: null }, viewer)).toBeNull();
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

describe('Workflow-produced messages', () => {
    const workflow = (outcome: 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result') => ({
        id: 'workflow-reply',
        producerV1: { v: 1 as const, kind: 'workflow' as const, runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0',
            execution: { kind: 'action' as const, actionId: 'review.verdict' }, outcome },
    });
    const result = (value: unknown, summary = 'Ship it') => DiscussionMessageContentV1Schema.parse({ kind: 'workflow_result', value, summary,
        source: { runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } });

    it('reads an Agent-produced Workflow reply from committed Run provenance without changing its Agent outcome', () => {
        const producer = DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'external-plugin-session', runId: 'run-1',
            replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome: 'answer',
                workflow: { runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } } });
        expect(resolveDiscussionWorkflowAttribution({ producerV1: producer })).toEqual({ runId: 'run-1', outcome: 'answer' });
        expect(resolveDiscussionReplyOutcome({ producerV1: producer })).toBe('answer');
    });

    it.each([false, true])('does not attribute an ordinary execution-run Agent publication to a Workflow (reply return: %s)', (reply) => {
        const producer = DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'external-plugin-session', runId: 'execution-run-1',
            ...(reply ? { replyReturn: { serverId: 'home', requestLocalId: 'ordinary-ask', outcome: 'answer' } } : {}) });
        expect(resolveDiscussionWorkflowAttribution({ producerV1: producer })).toBeNull();
        expect(resolveDiscussionReplyOutcome({ producerV1: producer })).toBe(reply ? 'answer' : null);
    });

    it.each(['execution-run-1', undefined])('uses the protected Workflow marker even when the generic runId is %s', (runId) => {
        const producer = DiscussionProducerV1Schema.parse({ v: 1, kind: 'agent', sessionId: 'external-plugin-session',
            ...(runId ? { runId } : {}), replyReturn: { serverId: 'home', requestLocalId: 'workflow-ask', outcome: 'cancelled',
                workflow: { runId: 'workflow-run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0' } } });
        expect(resolveDiscussionWorkflowAttribution({ producerV1: producer })).toEqual({ runId: 'workflow-run-1', outcome: 'cancelled' });
        expect(resolveDiscussionReplyOutcome({ producerV1: producer })).toBe('cancelled');
    });

    it('is attributed to its exact Run with its own outcome, never as an Agent reply', () => {
        expect(resolveDiscussionWorkflowAttribution(workflow('answer'))).toEqual({ runId: 'run-1', outcome: 'answer' });
        expect(resolveDiscussionWorkflowAttribution(workflow('terminal_no_result'))).toEqual({ runId: 'run-1', outcome: 'failed' });
        expect(resolveDiscussionWorkflowAttribution(workflow('cancelled'))).toEqual({ runId: 'run-1', outcome: 'cancelled' });
        // The Agent reply outcome reads only an Agent's stamped return.
        expect(resolveDiscussionReplyOutcome(workflow('failed'))).toBeNull();
        expect(resolveDiscussionWorkflowAttribution({ producerV1: null })).toBeNull();
        expect(resolveDiscussionWorkflowAttribution({ producerV1: { v: 1, kind: 'agent', sessionId: 'checkout-ui' } })).toBeNull();
    });

    it('names no requester and anchors no requester approval', () => {
        expect(resolveDiscussionReplyAttributionLine(workflow('answer'), { serverId: 'home', accountId: 'bob' })).toBeNull();
        const approval = { id: 'approval-1', requestRef: 'req-1', originMessageId: 'ask' };
        expect([...placeDiscussionRequesterApprovals([{ id: 'ask', producerV1: null }, workflow('answer')], [approval]).entries()])
            .toEqual([['ask', [approval]]]);
    });

    it('reads its summary as the message and keeps a typed value that says more as the result', () => {
        expect(readDiscussionMessagePreview(result({ verdict: 'ship' }))).toBe('Ship it');
        expect(readDiscussionWorkflowResultDetail(result({ verdict: 'ship', blockers: [] })))
            .toBe(JSON.stringify({ verdict: 'ship', blockers: [] }, null, 2));
        expect(readDiscussionWorkflowResultDetail(result('Ship it'))).toBeNull();
        expect(readDiscussionWorkflowResultDetail(result(3))).toBe('3');
        expect(readDiscussionWorkflowResultDetail({ v: 1, parts: [{ t: 'text', text: 'Ship it' }] })).toBeNull();
    });
});

describe('reply outcome presentation and speaker groups', () => {
    type Outcome = 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result';
    const body = (text: string) => DiscussionMessageContentV1Schema.parse({ v: 1, parts: [{ t: 'text', text }] });
    const agent = (outcome: Outcome | undefined, content: ReturnType<typeof body> | null = null) => ({
        authorAccountId: 'owner', content,
        producerV1: { v: 1 as const, kind: 'agent' as const, sessionId: 'checkout-ui',
            ...(outcome ? { replyReturn: { serverId: 'home', requestLocalId: 'ask-1', outcome } } : {}) },
    });
    const run = (outcome: Outcome, content: ReturnType<typeof body> | null = null) => ({
        authorAccountId: 'owner', content,
        producerV1: { v: 1 as const, kind: 'workflow' as const, runId: 'run-1', invocationRecordId: 'invocation-1', invocationAttempt: '0',
            execution: { kind: 'action' as const, actionId: 'review.verdict' }, outcome },
    });
    const partial = body('1. **Choose names** that describe intent.\n\n```ts\nconst activeUsers = users.filter(isActive);\n```');

    it('keeps a stopped reply that kept a partial answer as a message, marked stopped', () => {
        expect(resolveDiscussionReplyPresentation(agent('cancelled', partial))).toEqual({ kind: 'message', stopped: true });
        expect(resolveDiscussionReplyPresentation(run('cancelled', partial))).toEqual({ kind: 'message', stopped: true });
    });

    it('reads passed, failed and bodiless stopped outcomes as a compact notice', () => {
        expect(resolveDiscussionReplyPresentation(agent('pass'))).toEqual({ kind: 'notice', outcome: 'pass' });
        expect(resolveDiscussionReplyPresentation(agent('failed', body('Model unavailable')))).toEqual({ kind: 'notice', outcome: 'failed' });
        expect(resolveDiscussionReplyPresentation(agent('terminal_no_result'))).toEqual({ kind: 'notice', outcome: 'failed' });
        expect(resolveDiscussionReplyPresentation(agent('cancelled'))).toEqual({ kind: 'notice', outcome: 'cancelled' });
        expect(resolveDiscussionReplyPresentation(run('failed', body('Step 2 failed')))).toEqual({ kind: 'notice', outcome: 'failed' });
    });

    it('reads answers and ordinary messages as messages', () => {
        expect(resolveDiscussionReplyPresentation(agent('answer', body('Done')))).toEqual({ kind: 'message', stopped: false });
        expect(resolveDiscussionReplyPresentation(agent(undefined, body('FYI')))).toEqual({ kind: 'message', stopped: false });
        expect(resolveDiscussionReplyPresentation({ producerV1: null, content: body('Hi') })).toEqual({ kind: 'message', stopped: false });
    });

    it('starts its own speaker group for every reply with an outcome, even after the same speaker', () => {
        const person = { authorAccountId: 'owner', producerV1: null };
        expect(startsDiscussionMessageGroup(agent('cancelled', partial), person)).toBe(true);
        expect(startsDiscussionMessageGroup(agent('failed'), agent('answer', body('Earlier')))).toBe(true);
        expect(startsDiscussionMessageGroup(run('cancelled'), run('answer', body('Earlier')))).toBe(true);
        // Ordinary messages from one speaker still share a byline.
        expect(startsDiscussionMessageGroup(person, person)).toBe(false);
        expect(startsDiscussionMessageGroup(agent(undefined), agent(undefined))).toBe(false);
        expect(startsDiscussionMessageGroup(person, agent(undefined))).toBe(true);
        expect(startsDiscussionMessageGroup(person, undefined)).toBe(true);
    });
});
