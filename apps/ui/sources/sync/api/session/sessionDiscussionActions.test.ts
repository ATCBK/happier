import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionDiscussionCreateResponseV1 } from '@happier-dev/protocol';

const platformRandomUUID = vi.hoisted(() => vi.fn());

vi.mock('@/platform/randomUUID', () => ({ randomUUID: platformRandomUUID }));

import { createSessionDiscussionActionAdapter } from './sessionDiscussionActions';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { EncryptionCache } from '@/sync/encryption/encryptionCache';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { serializeSessionDiscussionMutationEqualityIntentV1 } from '@happier-dev/protocol/sessions/discussions/equality';

const session = { serverId: 'home-a', sessionId: 'session-a' } as const;
const availability = 'available' as const;
type DiscussionRequest = (path: string, init?: RequestInit) => Promise<Response>;

function createResponse(): SessionDiscussionCreateResponseV1 {
    return {
        discussion: {
            id: 'discussion-a',
            sessionId: session.sessionId,
            creationLocalId: 'create-local-a',
            titleContent: { t: 'plain', v: { v: 1, title: 'Release readiness' } },
            latestMessage: {
                id: 'message-a',
                localId: 'message-local-a',
                seq: 1,
                authorAccountId: 'account-a',
                accountActor: { v: 1, accountId: 'account-a', profile: null },
                producerV1: null,
                createdAt: 10,
            },
            messageSeq: 1,
            lastReadSeq: 1,
            unreadCount: 0,
            unreadMentionCount: 0,
            recentAuthorAccountIds: ['account-a'],
            archivedAt: null,
            capabilities: {
                postMessages: true,
                rename: true,
                archive: true,
                restore: false,
                askAgent: true,
                sendToSession: true,
            },
        },
        firstMessage: {
            id: 'message-a',
            discussionId: 'discussion-a',
            localId: 'message-local-a',
            seq: 1,
            authorAccountId: 'account-a',
            accountActor: { v: 1, accountId: 'account-a', profile: null },
            producerV1: null,
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] } },
            mentionedAccountIds: [],
            createdAt: 10,
        },
    };
}

describe('session Discussion UI Action adapter', () => {
    beforeEach(() => {
        platformRandomUUID.mockReset();
    });

    it.each(['plain', 'e2ee'] as const)('opens retained Discussion fields through the stored projection (%s)', async mode => {
        const response = createResponse();
        const title = { v: 1, title: 'Release readiness', retired: true };
        const content = { v: 1, retired: true, parts: [{ t: 'text', text: 'Ready?', retired: true }] };
        const encryption = mode === 'e2ee' ? new SessionEncryption(session.sessionId,
            new AES256Encryption(new Uint8Array(32).fill(4)), new EncryptionCache(), new Uint8Array(32).fill(5)) : null;
        const envelope = async (value: unknown) => mode === 'plain'
            ? { t: 'plain', v: value } : { t: 'encrypted', c: await encryption!.encryptRaw(value) };
        const titleContent = await envelope(title);
        const messageContent = await envelope(content);
        const request = vi.fn<DiscussionRequest>(async () => new Response(JSON.stringify({
            ...response,
            discussion: { ...response.discussion, titleContent },
            firstMessage: { ...response.firstMessage, content: messageContent },
        }), { status: 200 }));
        const execute = createSessionDiscussionActionAdapter({
            session, availability,
            request,
            contentContext: mode === 'plain' ? { mode } : { mode, encryption },
        });
        const result = await execute({
            actionId: 'session.discussion.create',
            input: { sessionId: session.sessionId, creationLocalId: 'create-local-a', title: 'Release readiness',
                firstMessage: { localId: 'message-local-a', content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] } } },
            context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
        });

        expect(result).toMatchObject({ discussion: { title: 'Release readiness' },
            firstMessage: { content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] } } });
        expect(result).not.toHaveProperty('firstMessage.content.retired');
        expect(result).not.toHaveProperty('firstMessage.content.parts.0.retired');
        if (mode === 'e2ee') {
            const authoredTitle = { v: 1 as const, title: 'Release readiness' };
            const authoredContent = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Ready?' }] };
            expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
                creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: encryption!.deriveDiscussionMutationEqualityTagV1(
                    serializeSessionDiscussionMutationEqualityIntentV1({ kind: 'create', title: authoredTitle,
                        firstMessage: { localId: 'message-local-a', content: authoredContent, mentionedAccountIds: [] } }),
                ) },
                firstMessage: { requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: encryption!.deriveDiscussionMutationEqualityTagV1(
                    serializeSessionDiscussionMutationEqualityIntentV1({ kind: 'post', content: authoredContent, mentionedAccountIds: [] }),
                ) } },
            });
        }
    });

    it('keeps malformed known stored Discussion content unavailable', async () => {
        const response = createResponse();
        const execute = createSessionDiscussionActionAdapter({ session, availability, contentContext: { mode: 'plain' },
            request: async () => new Response(JSON.stringify({ ...response,
                discussion: { ...response.discussion, titleContent: { t: 'plain', v: { v: 1, title: 42, retired: true } } },
                firstMessage: { ...response.firstMessage, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 42, retired: true }] } } },
            }), { status: 200 }),
        });
        await expect(execute({ actionId: 'session.discussion.create',
            input: { sessionId: session.sessionId, creationLocalId: 'create-local-a', title: 'Release readiness',
                firstMessage: { localId: 'message-local-a', content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] } } },
            context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
        })).resolves.toMatchObject({ discussion: { title: null }, firstMessage: { content: null } });
    });

    it('uses the platform UUID owner for every omitted mutation identity without global crypto', async () => {
        platformRandomUUID
            .mockReturnValueOnce('generated-create-local')
            .mockReturnValueOnce('generated-first-message-local')
            .mockReturnValueOnce('generated-post-local');
        vi.stubGlobal('crypto', undefined);
        const request = vi.fn<DiscussionRequest>(async () => new Response(JSON.stringify({ error: 'session_discussion_not_found' }), { status: 404 }));
        const execute = createSessionDiscussionActionAdapter({
            session,
            availability,
            request,
            contentContext: { mode: 'plain' },
        });

        try {
            await execute({
                actionId: 'session.discussion.create',
                input: {
                    sessionId: session.sessionId,
                    title: 'Release readiness',
                    firstMessage: {
                        content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] },
                        mentionedAccountIds: [],
                    },
                },
                context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
            });
            await execute({
                actionId: 'session.discussion.post',
                input: {
                    sessionId: session.sessionId,
                    discussionId: 'discussion-a',
                    content: { v: 1, parts: [{ t: 'text', text: 'Follow-up' }] },
                    mentionedAccountIds: [],
                },
                context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
            });
        } finally {
            vi.unstubAllGlobals();
        }

        expect(platformRandomUUID).toHaveBeenCalledTimes(3);
        expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
            creationLocalId: 'generated-create-local',
            firstMessage: { localId: 'generated-first-message-local' },
        });
        expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({
            localId: 'generated-post-local',
        });
    });

    it('preserves distinct caller-owned create and first-message identities in the canonical final body', async () => {
        const request = vi.fn<DiscussionRequest>(async () => new Response(JSON.stringify(createResponse()), { status: 200 }));
        const execute = createSessionDiscussionActionAdapter({
            session,
            availability,
            request,
            contentContext: { mode: 'plain' },
        });

        const result = await execute({
            actionId: 'session.discussion.create',
            input: {
                sessionId: session.sessionId,
                creationLocalId: 'create-local-a',
                title: 'Release readiness',
                firstMessage: {
                    localId: 'message-local-a',
                    content: { v: 1, parts: [{ t: 'text', text: 'Ready?' }] },
                    mentionedAccountIds: [],
                },
            },
            context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
        });

        expect(result).toMatchObject({ discussion: { creationLocalId: 'create-local-a' }, firstMessage: { localId: 'message-local-a' } });
        expect(result).not.toHaveProperty('discussion.titleContent');
        expect(result).not.toHaveProperty('firstMessage.content.t');
        const [, init] = request.mock.calls[0]!;
        expect(JSON.parse(String(init?.body))).toMatchObject({
            creationLocalId: 'create-local-a',
            firstMessage: { localId: 'message-local-a' },
        });
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('requestEqualityEvidenceV1');
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('firstMessage.requestEqualityEvidenceV1');
        expect(platformRandomUUID).not.toHaveBeenCalled();
    });

    it('places E2EE equality evidence on the create and nested first-message fields', async () => {
        const title = { v: 1 as const, title: 'Release readiness' };
        const content = { v: 1 as const, parts: [{ t: 'text' as const, text: 'Ready?' }] };
        const response = createResponse();
        const request = vi.fn<DiscussionRequest>(async () => new Response(JSON.stringify({
            ...response,
            discussion: { ...response.discussion, titleContent: { t: 'encrypted', c: JSON.stringify(title) } },
            firstMessage: { ...response.firstMessage, content: { t: 'encrypted', c: JSON.stringify(content) } },
        }), { status: 200 }));
        const execute = createSessionDiscussionActionAdapter({
            session,
            availability,
            request,
            contentContext: {
                mode: 'e2ee',
                encryption: {
                    encryptRaw: async (value) => JSON.stringify(value),
                    decryptRaw: async (ciphertext) => JSON.parse(ciphertext) as unknown,
                    deriveDiscussionMutationEqualityTagV1: () => 'A'.repeat(43),
                },
            },
        });

        await execute({
            actionId: 'session.discussion.create',
            input: {
                sessionId: session.sessionId,
                creationLocalId: 'create-local-a',
                title: title.title,
                firstMessage: { localId: 'message-local-a', content, mentionedAccountIds: [] },
            },
            context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
        });

        const [, init] = request.mock.calls[0]!;
        expect(JSON.parse(String(init?.body))).toMatchObject({
            creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
            firstMessage: {
                requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: 'A'.repeat(43) },
            },
        });
    });

    it('refuses an invocation addressed to a different Home before any request', async () => {
        const request = vi.fn<DiscussionRequest>();
        const execute = createSessionDiscussionActionAdapter({
            session,
            availability,
            request,
            contentContext: { mode: 'plain' },
        });

        await expect(execute({
            actionId: 'session.discussion.archive',
            input: { sessionId: session.sessionId, discussionId: 'discussion-a' },
            context: { surface: 'ui', serverId: 'home-b', defaultSessionId: session.sessionId },
        })).resolves.toEqual({ ok: false, errorCode: 'session_discussion_not_found', error: 'session_discussion_not_found' });
        expect(request).not.toHaveBeenCalled();
    });

    it('fails a malformed success response closed instead of projecting an unvalidated row', async () => {
        const execute = createSessionDiscussionActionAdapter({
            session,
            availability,
            request: vi.fn(async () => new Response(JSON.stringify({ discussions: [{ id: 'untrusted' }], nextCursor: null }), { status: 200 })),
            contentContext: { mode: 'plain' },
        });

        await expect(execute({
            actionId: 'session.discussion.list',
            input: { sessionId: session.sessionId, state: 'active' },
            context: { surface: 'ui', serverId: session.serverId, defaultSessionId: session.sessionId },
        })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    });
});
