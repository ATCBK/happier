import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ToolCallMessage } from "@happier-dev/session-core/messages";

import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import { resolveMessageActionNeighbourGapPx } from '@/components/sessions/transcript/messageActions/messageActionNeighbourGap';
import {
    type TranscriptSessionCommonProps,
    useTranscriptSessionCommon,
} from '@/components/sessions/transcript/transcriptSessionCommon';

import {
    resolveToolCallsGroupChromeVariant,
    resolveToolCallsGroupSummary,
    toolCallsGroupChromeModeForVariant,
    ToolCallsGroupHeaderChrome,
    ToolCallsGroupUnitRowFrame,
} from './toolCallsGroupChrome';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { ToolCallsGroupUnitRowCommonProps } from './unitRowProps';

type ToolCallsGroupUnitHeaderRowProps = ToolCallsGroupUnitRowCommonProps & Readonly<{
    toolMessages: ToolCallMessage[];
    approvalRequests?: readonly OpenApprovalArtifactForSession[];
    expanded: boolean;
    setExpanded: (expanded: boolean) => void;
}>;

export const ToolCallsGroupUnitHeaderRow = React.memo(function ToolCallsGroupUnitHeaderRow(
    props: ToolCallsGroupUnitHeaderRowProps,
) {
    const transcriptSessionCommon = useTranscriptSessionCommon();

    return (
        <ToolCallsGroupUnitHeaderRowWithSessionCommon
            {...props}
            forkCommon={transcriptSessionCommon.fork}
            messageDisplayCommon={transcriptSessionCommon.messageDisplay}
            toolChromeCommon={transcriptSessionCommon.toolChrome}
            toolRouteCommon={transcriptSessionCommon.toolRoute}
        />
    );
});

export const ToolCallsGroupUnitHeaderRowWithSessionCommon = React.memo(function ToolCallsGroupUnitHeaderRowWithSessionCommon(
    props: ToolCallsGroupUnitHeaderRowProps & TranscriptSessionCommonProps,
) {
    const { theme } = useUnistyles();
    const variant = resolveToolCallsGroupChromeVariant(props.toolChromeCommon);
    const chromeMode = toolCallsGroupChromeModeForVariant(variant);
    const { setExpanded } = props;
    const onToggleExpanded = React.useCallback(() => setExpanded(!props.expanded), [props.expanded, setExpanded]);

    const summary = resolveToolCallsGroupSummary({
        showToolCalls: props.toolChromeCommon.showToolCalls,
        toolMessages: props.toolMessages,
        permissionDisabledReason: props.interaction.permissionDisabledReason,
        approvalRequests: props.approvalRequests,
        sessionId: props.sessionId,
    });

    if (props.toolMessages.length === 0) return null;

    const createdAt = props.toolMessages[0]?.createdAt ?? Date.now();
    const webPrependAnchorId = props.toolMessages[props.toolMessages.length - 1]?.id ?? props.groupId;

    return (
        <View testID={`${TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX}${webPrependAnchorId}`}>
            <TranscriptEnterWrapper id={props.groupId} createdAt={createdAt}>
                <ToolCallsGroupUnitRowFrame
                    variant={variant}
                    position="header"
                    unitTestID="transcript-tool-calls-unit-header"
                >
                    <ToolCallsGroupHeaderChrome
                        chromeMode={chromeMode}
                        status={summary.status}
                        outcomes={summary}
                        count={props.toolMessages.length}
                        expanded={props.expanded}
                        onToggleExpanded={onToggleExpanded}
                        showToolCalls={props.toolChromeCommon.showToolCalls}
                        // The row above is a message's action row, whose buttons overhang into this card: split the room.
                        hitReach={{ top: resolveMessageActionNeighbourGapPx(theme) / 2 }}
                    />
                </ToolCallsGroupUnitRowFrame>
            </TranscriptEnterWrapper>
        </View>
    );
});
