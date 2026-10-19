import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Message } from '@happier-dev/session-core/messages';
import type { Metadata } from '@happier-dev/session-core/state';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import { listPendingSessionRequests } from './listPendingSessionRequests';

describe('pending request facts adapter', () => {
    it('uses stored public completions for recipients, ignoring additive fields but rejecting invalid known fields', () => {
        const requestId = 'permission-publicly-completed';
        const createdAt = 1_000;
        const messages: Message[] = [{
            id: 'message-publicly-completed',
            kind: 'tool-call',
            localId: null,
            createdAt,
            tool: {
                id: 'tool-publicly-completed',
                name: 'Bash',
                state: 'running',
                input: { command: 'git status' },
                createdAt,
                startedAt: createdAt,
                completedAt: null,
                description: null,
                permission: {
                    id: requestId,
                    status: 'pending',
                },
            },
            children: [],
        }];
        const completedRequests = {
            [requestId]: {
                tool: 'Bash',
                kind: 'permission',
                createdAt,
                completedAt: createdAt + 100,
                status: 'approved',
            },
        };
        const sharedMetadata = {
            v: 1,
            publicAgentState: {
                completedRequests,
            },
        } as unknown as Metadata;

        const recipient = createSessionFixture({
            active: true,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            agentState: null,
        });
        const owner = createSessionFixture({
            active: true,
            metadataLayoutVersion: 1,
            metadata: sharedMetadata,
            agentState: {
                requests: {},
                completedRequests: {},
            },
        });
        const additiveRecipient = createSessionFixture({
            active: true,
            accessLevel: 'view',
            metadataLayoutVersion: 1,
            metadata: {
                ...sharedMetadata,
                path: '/private/path-must-not-pass',
            },
            agentState: null,
        });
        const malformedRecipient = createSessionFixture({
            ...additiveRecipient,
            metadata: {
                ...sharedMetadata,
                path: '/private/path-must-not-pass',
                publicAgentState: {
                    completedRequests: {
                        [requestId]: {
                            ...completedRequests[requestId],
                            status: 'invalid-status',
                        },
                    },
                },
            },
        });

        expect(readSessionPresentationCompletedRequests(recipient)).toEqual(
            completedRequests,
        );
        expect(listPendingSessionRequests(recipient, messages)).toEqual([]);
        expect(listPendingSessionRequests(owner, messages)).toEqual([
            expect.objectContaining({ id: requestId, tool: 'Bash' }),
        ]);
        expect(readSessionPresentationCompletedRequests(additiveRecipient)).toEqual(completedRequests);
        expect(listPendingSessionRequests(additiveRecipient, messages)).toEqual([]);
        expect(readSessionPresentationCompletedRequests(malformedRecipient)).toBeNull();
        expect(listPendingSessionRequests(malformedRecipient, messages)).toEqual([
            expect.objectContaining({ id: requestId, tool: 'Bash' }),
        ]);
    });

});
