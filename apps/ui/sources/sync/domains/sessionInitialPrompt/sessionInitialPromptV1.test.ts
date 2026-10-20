import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@happier-dev/session-core/state';
import { prepareDiscussionSelectionHandoff } from '@/components/discussions/prepareDiscussionSelectionHandoff';
import { DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import {
    clearSessionInitialPromptV1,
    readSessionInitialPromptV1,
    writeSessionInitialPromptV1,
} from './sessionInitialPromptV1';

describe('sessionInitialPromptV1', () => {
    it('round-trips replace prompts with source context', () => {
        const metadata = writeSessionInitialPromptV1({
            metadata: MetadataSchema.parse({}),
            text: '  first line\nsecond line  ',
            mode: 'replace',
            createdAtMs: 1,
            sourceMessageIds: ['m1', 'm2'],
            sourceSessionId: 'source-session',
        });

        expect(readSessionInitialPromptV1(metadata)).toEqual({
            v: 1,
            text: '  first line\nsecond line  ',
            mode: 'replace',
            createdAtMs: 1,
            sourceMessageIds: ['m1', 'm2'],
            sourceSessionId: 'source-session',
        });
    });

    it('round-trips append prompts', () => {
        const metadata = writeSessionInitialPromptV1({
            metadata: MetadataSchema.parse({}),
            text: 'append me',
            mode: 'append',
            createdAtMs: 2,
        });

        expect(readSessionInitialPromptV1(metadata)?.mode).toBe('append');
    });

    it('round-trips an exact Discussion selection source without Run draft correlation', () => {
        const prepared = prepareDiscussionSelectionHandoff({
            serverId: 'server-a',
            discussionId: 'discussion-a',
            selectedMessageIds: ['message-4', 'message-2'],
            messages: ['message-2', 'message-4'].map((id, index) => {
                const content = { v: 1 as const, parts: [{ t: 'text' as const, text: id }] };
                const committed = DiscussionMessageV1Schema.parse({
                    id, discussionId: 'discussion-a', localId: null, seq: index + 1,
                    authorAccountId: 'alice', accountActor: null, producerV1: null,
                    content: { t: 'plain', v: content }, mentionedAccountIds: [], createdAt: 1,
                });
                return { ...committed, content, messageRef: createDiscussionMessageRefV1({ serverId: 'server-a', discussionId: committed.discussionId }, committed) };
            }),
            resolveAccountLabel: () => 'Alice',
            format: 'plain',
            roleLabels: { user: 'User', assistant: 'Assistant' },
            agentAttributionLabel: 'Via Agent',
        });
        expect(prepared).not.toBeNull();
        const metadata = writeSessionInitialPromptV1({
            metadata: MetadataSchema.parse({}),
            text: 'selected messages',
            mode: 'append',
            createdAtMs: 2,
            source: prepared!.source,
        });

        expect(readSessionInitialPromptV1(metadata)?.source).toEqual({
            kind: 'discussion',
            serverId: 'server-a',
            discussionId: 'discussion-a',
            messageIds: ['message-2', 'message-4'],
        });
        expect(readSessionInitialPromptV1(metadata)?.source).not.toHaveProperty('draftCorrelationId');
    });

    it('reads retained Discussion handoff source fields without restoring unknown draft correlation', () => {
        const metadata = {
            ...MetadataSchema.parse({}),
            sessionInitialPromptV1: {
                v: 1 as const,
                text: 'selected messages',
                mode: 'append' as const,
                createdAtMs: 2,
                source: {
                    kind: 'discussion' as const,
                    serverId: 'server-a',
                    discussionId: 'discussion-a',
                    messageIds: ['message-2'],
                    draftCorrelationId: 'draft-a',
                    retired: { enabled: true },
                },
            },
        };

        expect(readSessionInitialPromptV1(metadata)?.source).toEqual({
            kind: 'discussion', serverId: 'server-a', discussionId: 'discussion-a', messageIds: ['message-2'],
        });
        expect(readSessionInitialPromptV1(metadata)?.source).not.toHaveProperty('draftCorrelationId');
    });

    it('preserves metadata when writing blank prompts', () => {
        const metadata = MetadataSchema.parse({ other: 'value' });

        expect(writeSessionInitialPromptV1({
            metadata,
            text: '  \n\t ',
            mode: 'append',
            createdAtMs: 3,
        })).toBe(metadata);
    });

    it('clears the stored prompt without disturbing other metadata', () => {
        const metadata = MetadataSchema.parse({
            other: 'value',
            sessionInitialPromptV1: {
                v: 1,
                text: 'hello',
                mode: 'replace',
                createdAtMs: 1,
            },
        });

        expect(clearSessionInitialPromptV1({ metadata })).toEqual({
            path: '',
            host: '',
            other: 'value',
        });
    });

    it('returns the same metadata reference when there is no stored prompt to clear', () => {
        const metadata = MetadataSchema.parse({ other: 'value' });

        expect(clearSessionInitialPromptV1({ metadata })).toBe(metadata);
    });

    it('returns null for malformed metadata', () => {
        expect(readSessionInitialPromptV1(MetadataSchema.parse({ sessionInitialPromptV1: 'nope' }))).toBeNull();
        expect(readSessionInitialPromptV1(MetadataSchema.parse({
            sessionInitialPromptV1: { v: 1, text: 'valid text', mode: 'invalid', createdAtMs: 1 },
        }))).toBeNull();
        expect(readSessionInitialPromptV1(MetadataSchema.parse({
            sessionInitialPromptV1: { v: 1, text: '   ', mode: 'append', createdAtMs: 1 },
        }))).toBeNull();
    });
});
