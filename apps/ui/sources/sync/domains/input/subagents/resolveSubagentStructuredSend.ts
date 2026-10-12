import { resolveSubagentCommandStructuredSend, type SubagentCommandV1 } from '@happier-dev/protocol/messages/structured/subagentCommandV1';
import { resolveSubagentLaunchStructuredSend, type SubagentLaunchV1 } from '@happier-dev/protocol/messages/structured/subagentLaunchV1';

type ResolveSubagentStructuredSendParams =
    | Readonly<{
        envelopeKind: 'subagent_launch.v1';
        payload: SubagentLaunchV1;
    }>
    | Readonly<{
        envelopeKind: 'subagent_command.v1';
        payload: SubagentCommandV1;
    }>;

export function resolveSubagentStructuredSend(params: ResolveSubagentStructuredSendParams): Readonly<{
    text: string;
    displayText: string;
    metaOverrides: Readonly<{
        happier: Readonly<{
            kind: 'subagent_launch.v1' | 'subagent_command.v1';
            payload: SubagentLaunchV1 | SubagentCommandV1;
        }>;
    }>;
}> {
    if (params.envelopeKind === 'subagent_launch.v1') {
        const resolved = resolveSubagentLaunchStructuredSend(params.payload);
        return {
            text: resolved.text,
            displayText: resolved.displayText,
            metaOverrides: resolved.messageMeta,
        };
    }

    const resolved = resolveSubagentCommandStructuredSend(params.payload);
    return {
        text: resolved.text,
        displayText: resolved.displayText,
        metaOverrides: resolved.messageMeta,
    };
}
