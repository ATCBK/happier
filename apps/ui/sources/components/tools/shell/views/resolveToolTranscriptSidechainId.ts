import { readSubAgentToolSidechainId } from '@happier-dev/protocol/tools/v2';
import type { ToolCall } from '@happier-dev/session-core/messages';

export function resolveToolTranscriptSidechainId(params: Readonly<{
    tool: ToolCall;
    normalizedToolName: string;
}>): string | null {
    return readSubAgentToolSidechainId(params.tool, params.normalizedToolName);
}
