import { z } from 'zod/mini';
import {
    DiscussionSelectionSourceV1Schema,
    type DiscussionSelectionSourceV1,
} from '@happier-dev/protocol/discussions/content';

import { applySendToSessionTemplate } from '@/components/sessions/transcript/messageSelection/applySendToSessionTemplate';
import type { SessionInitialPromptV1 } from '@/sync/domains/sessionInitialPrompt/sessionInitialPromptV1';

type SendSelectionSource = Omit<DiscussionSelectionSourceV1, 'draftCorrelationId'>;

/**
 * Adapts a Home-qualified selection to the canonical Session initial-prompt handoff.
 * The initial-prompt consumer owns append/currentness; this function never enqueues input.
 */
export async function sendDiscussionSelectionToSession(params: Readonly<{
    sessionId: string;
    serverId: string;
    selectedText: string;
    source: SendSelectionSource;
    template: string;
    sourceSessionName: string | null;
    nowMs: () => number;
    writeInitialPrompt: (input: Readonly<{
        destinationSessionId: string;
        serverId: string;
        prompt: SessionInitialPromptV1;
    }>) => Promise<void>;
    revealPrimaryComposer: () => void | Promise<void>;
    focusPrimaryComposer: () => boolean | void | Promise<boolean | void>;
}>): Promise<boolean> {
    const sourceResult = z.omit(DiscussionSelectionSourceV1Schema, { draftCorrelationId: true })
        .safeParse(params.source);
    if (!sourceResult.success || sourceResult.data.serverId !== params.serverId) return false;
    const promptText = applySendToSessionTemplate({
        template: params.template,
        formattedMessages: params.selectedText,
        selectedCount: sourceResult.data.messageIds.length,
        sourceSessionName: params.sourceSessionName,
    });
    if (!promptText.trim()) return false;

    await params.writeInitialPrompt({
        destinationSessionId: params.sessionId,
        serverId: params.serverId,
        prompt: {
            v: 1,
            text: promptText,
            mode: 'append',
            createdAtMs: params.nowMs(),
            source: sourceResult.data,
        },
    });
    await params.revealPrimaryComposer();
    await params.focusPrimaryComposer();
    return true;
}
