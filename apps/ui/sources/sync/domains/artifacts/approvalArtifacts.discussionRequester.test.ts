import { describe, expect, it } from 'vitest';

import { listDiscussionRequesterApprovals } from './approvalArtifacts';
import { buildDiscussionRequesterApprovalArtifact } from './approvalArtifacts.discussionRequester.testkit';

describe('listDiscussionRequesterApprovals', () => {
    const discussion = { serverId: 'server-1', discussionId: 'discussion-1' };

    it('joins a requester-bound approval to the Discussion message that asked, with its exact cause', () => {
        const approvals = listDiscussionRequesterApprovals([buildDiscussionRequesterApprovalArtifact()], discussion);
        expect(approvals).toHaveLength(1);
        expect(approvals[0]).toMatchObject({
            originMessageId: 'message-ask',
            requestRef: 'bob-input',
            subject: { requesterAccountId: 'bob', executionAccountId: 'alice', personaSessionRef: { serverId: 'server-1', sessionId: 's1' } },
        });
    });

    it('keeps a decided request so its receipt replaces the card in place', () => {
        const declined = buildDiscussionRequesterApprovalArtifact({ settle: (request) => ({
            ...request, status: 'rejected', updatedAtMs: 20,
            decision: { kind: 'reject', decidedAtMs: 20, authority: 'present_user', decidingAccountId: 'bob' },
        }) });
        expect(listDiscussionRequesterApprovals([declined], discussion).map((entry) => entry.parsed.request.status)).toEqual(['rejected']);
    });

    it('ignores requests from another Discussion, from a Session, or with no Discussion origin', () => {
        const otherDiscussion = buildDiscussionRequesterApprovalArtifact({ id: 'a', discussionId: 'discussion-2' });
        const fromSession = buildDiscussionRequesterApprovalArtifact({ id: 'b', origin: {
            kind: 'session', session: { serverId: 'server-1', sessionId: 's9' }, messageId: 'm1' } });
        const noOrigin = buildDiscussionRequesterApprovalArtifact({ id: 'c', origin: null });
        expect(listDiscussionRequesterApprovals([otherDiscussion, fromSession, noOrigin], discussion)).toEqual([]);
    });
});
