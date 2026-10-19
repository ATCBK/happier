import { describe, expect, it, vi } from 'vitest';

import { sendDiscussionSelectionToSession } from '@/components/discussions/sendDiscussionSelectionToSession';

describe('sendDiscussionSelectionToSession', () => {
    it('writes an append initial prompt with exact Discussion source before revealing and focusing', async () => {
        const calls: string[] = [];
        const writeInitialPrompt = vi.fn(async () => { calls.push('write'); });
        const revealPrimaryComposer = vi.fn(async () => { calls.push('reveal'); });
        const focusPrimaryComposer = vi.fn(() => { calls.push('focus'); return true; });

        await expect(sendDiscussionSelectionToSession({
            sessionId: 'session-a',
            serverId: 'server-a',
            selectedText: '**Alice:**\n\nPlease review',
            source: {
                kind: 'discussion',
                serverId: 'server-a',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
            },
            template: 'Review this selection:\n\n{{MESSAGES}}',
            sourceSessionName: 'Primary',
            nowMs: () => 42,
            writeInitialPrompt,
            revealPrimaryComposer,
            focusPrimaryComposer,
        })).resolves.toBe(true);

        expect(writeInitialPrompt).toHaveBeenCalledWith({
            destinationSessionId: 'session-a',
            serverId: 'server-a',
            prompt: {
                v: 1,
                text: 'Review this selection:\n\n**Alice:**\n\nPlease review',
                mode: 'append',
                createdAtMs: 42,
                source: {
                    kind: 'discussion',
                    serverId: 'server-a',
                    discussionId: 'discussion-a',
                    messageIds: ['message-a'],
                },
            },
        });
        expect(calls).toEqual(['write', 'reveal', 'focus']);
    });

    it('rejects the same raw Discussion identity from another Home before writing', async () => {
        const writeInitialPrompt = vi.fn();
        await expect(sendDiscussionSelectionToSession({
            sessionId: 'session-a',
            serverId: 'server-a',
            selectedText: 'message',
            source: {
                kind: 'discussion',
                serverId: 'other-home',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
            },
            template: '{{MESSAGES}}',
            sourceSessionName: null,
            nowMs: () => 1,
            writeInitialPrompt,
            revealPrimaryComposer: () => undefined,
            focusPrimaryComposer: () => true,
        })).resolves.toBe(false);
        expect(writeInitialPrompt).not.toHaveBeenCalled();
    });
});
