import { readTurnChangeToolMetadataFromToolCall } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import { isTranscriptSessionBoardItemReplyCallV1 } from '@happier-dev/protocol/sessions/board';
import { readReviewToolRunId } from '@/components/sessions/reviews/messages/projectReviewToolMessage';

import type { Message, ToolCallMessage } from "@happier-dev/session-core/messages";

export function isToolCallMessageGroupableInTranscript(message: Message): message is ToolCallMessage {
    if (message.kind !== 'tool-call') return false;

    // A review owns its result card from admission onward, including while its
    // retained Run is still running, so findings never move it into or out of a group.
    if (readReviewToolRunId(message) !== null) return false;

    if (readTurnChangeToolMetadataFromToolCall(message.tool) != null) {
        return false;
    }

    // A call that answered with a transcript visual stands alone: the visual is the agent's reply, so it
    // sits in the reply column with its call as a quiet line, never inside a tool group's well.
    const { tool } = message;
    if (isTranscriptSessionBoardItemReplyCallV1({ toolName: tool.name, state: tool.state, input: tool.input, result: tool.result })) {
        return false;
    }

    // An unanswered permission, question or credential request owns interactive
    // controls; ordinary tool disclosure must never conceal those controls.
    return message.tool.permission?.status !== 'pending';
}
