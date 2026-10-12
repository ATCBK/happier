import { describe, expect, it } from 'vitest';
import type { ConversationBindingV1 } from './targets.js';
import { resolveSessionPullRequestLinksV1, SessionPullRequestLinksV1Schema } from './sessionPullRequestBindings.js';

function binding(id: string, createdAt: number, sessionId: string, number: number): ConversationBindingV1 {
    return {
        v: 1, id, createdAt, updatedAt: createdAt, connectionId: 'connection-1',
        endpoint: { kind: 'githubPullRequest', audience: 'shared', id: `pr-${number}`, pullRequest: { repository: 'acme/widgets', number } },
        target: { kind: 'session', sessionId, pullRequestLink: { repository: 'acme/widgets', number },
            policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly',
        inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1,
        enabled: false, deletionState: 'none',
    };
}

describe('Session pull-request link projection', () => {
    it('projects only identity-qualified PR observations and uses the freshest duplicate binding', () => {
        const first = binding('a', 1, 'session-1', 1);
        const observed = (id: string, state: 'open' | 'merged', observedAt: number): ConversationBindingV1 => ({
            ...first, id, endpoint: { ...first.endpoint, kind: 'githubPullRequest', audience: 'shared',
                pullRequest: { repository: 'acme/widgets', number: 1 }, pullRequestState: { state, observedAt } },
        });
        expect(resolveSessionPullRequestLinksV1([observed('a', 'open', 10), observed('b', 'merged', 20)]))
            .toMatchObject([{ pullRequestLinks: [{ state: 'merged', observedAt: 20 }] }]);
        expect(resolveSessionPullRequestLinksV1([{ ...observed('c', 'merged', 30),
            endpoint: { ...observed('c', 'merged', 30).endpoint, kind: 'githubPullRequest', audience: 'shared',
                pullRequest: { repository: 'another/widgets', number: 1 }, pullRequestState: { state: 'merged', observedAt: 30 } },
        }])[0]?.pullRequestLinks[0]).not.toHaveProperty('state');
    });

    it('projects ordered distinct per-session links from retained bindings, including disabled trigger history', () => {
        const historical = { ...binding('binding-b', 1, 'session-1', 2), target: { kind: 'automation', automationId: 'automation-1', policy: { resultDelivery: 'none' }, scopedTrigger: {
            sessionId: 'session-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind: 'prComment',
            principalPolicy: 'repositoryWriters', pullRequest: { repository: 'acme/widgets', number: 2 },
        } } } satisfies ConversationBindingV1;
        const deleting = { ...binding('binding-deleted', 0, 'session-deleted', 9), enabled: false, deletionState: 'finalizingDelete' } satisfies ConversationBindingV1;
        const ordinaryAutomation = { ...binding('binding-ordinary', 0, 'session-unlinked', 9),
            target: { kind: 'automation', automationId: 'automation-ordinary', policy: { resultDelivery: 'finalResult' } },
        } satisfies ConversationBindingV1;
        const bindings = [binding('binding-z', 4, 'session-2', 2), binding('binding-duplicate', 3, 'session-1', 2), historical,
            binding('binding-a', 1, 'session-1', 1), deleting, ordinaryAutomation];
        expect(resolveSessionPullRequestLinksV1(bindings)).toEqual([
            { sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1' }, { provider: 'github', repository: 'acme/widgets', number: 2, url: 'https://github.com/acme/widgets/pull/2' }] },
            { sessionId: 'session-2', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 2, url: 'https://github.com/acme/widgets/pull/2' }] },
        ]);
        expect(bindings[0]?.id).toBe('binding-z');
    });

    it('requires exact Session qualification on the public list projection', () => {
        const projection = { sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/pull/1' }] };
        expect(SessionPullRequestLinksV1Schema.parse(projection)).toEqual(projection);
        expect(SessionPullRequestLinksV1Schema.safeParse({ pullRequestLinks: projection.pullRequestLinks }).success).toBe(false);
        expect(SessionPullRequestLinksV1Schema.safeParse({ ...projection, unknown: true }).success).toBe(false);
    });
});
