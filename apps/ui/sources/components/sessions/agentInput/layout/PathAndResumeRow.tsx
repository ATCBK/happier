import * as React from 'react';
import { View, type View as RNView } from 'react-native';
import { ResumeChip } from './ResumeChip';
import {
    AgentInputFolderChip,
    type AgentInputFolderChipState,
} from '@/components/sessions/agentInput/definitions/AgentInputFolderChip';


export type PathAndResumeRowStyles = {
    pathRow: any;
    actionButtonsLeft: any;
    actionChip: any;
    actionChipIconOnly: any;
    actionChipPressed: any;
    actionChipText: any;
};

export type PathAndResumeRowProps = {
    styles: PathAndResumeRowStyles;
    leadingControls?: ReadonlyArray<React.ReactNode>;
    /** Location controls that follow the folder and resume controls. */
    trailingControls?: ReadonlyArray<React.ReactNode>;
    fillAvailableWidth?: boolean;
    showChipLabels: boolean;
    iconColor: string;
    folderChipState: AgentInputFolderChipState;
    pathChipAnchorRef?: React.RefObject<RNView | null>;
    onPathClick?: () => void;
    onRemoveFolder?: () => void;
    resumeSessionId?: string | null;
    resumeChipAnchorRef?: React.RefObject<RNView | null>;
    onResumeClick?: () => void;
    resumeLabelTitle: string;
    resumeLabelOptional: string;
};

export function PathAndResumeRow(props: PathAndResumeRowProps) {
    const leadingControls = props.leadingControls?.filter(Boolean) ?? [];
    const trailingControls = props.trailingControls?.filter(Boolean) ?? [];
    const hasPath = Boolean(props.onPathClick);
    const hasResume = Boolean(props.onResumeClick);
    if (leadingControls.length === 0 && trailingControls.length === 0 && !hasPath && !hasResume) return null;
    const widthFillStyle = props.fillAvailableWidth === false ? null : { flex: 1, minWidth: 0 };

    return (
        <View style={[props.styles.pathRow, widthFillStyle]} testID="agentInput-pathResumeRow">
            <View style={[props.styles.actionButtonsLeft, widthFillStyle]}>
                {leadingControls}
                {hasPath ? (
                    // Keep the folder readable on phones: the row wraps the chip whole instead of
                    // compressing it into an icon-only sliver.
                    <AgentInputFolderChip
                        anchorRef={props.pathChipAnchorRef}
                        state={props.folderChipState}
                        tint={props.iconColor}
                        chipStyle={(pressed) => [props.styles.actionChip, pressed ? props.styles.actionChipPressed : null]}
                        textStyle={props.styles.actionChipText}
                        onPress={props.onPathClick!}
                        onRemove={props.onRemoveFolder}
                        layout="wrap"
                    />
                ) : null}

                {hasResume ? (
                        <ResumeChip
                        anchorRef={props.resumeChipAnchorRef}
                        onPress={props.onResumeClick!}
                        showLabel={props.showChipLabels}
                        resumeSessionId={props.resumeSessionId}
                        labelTitle={props.resumeLabelTitle}
                        labelOptional={props.resumeLabelOptional}
                        iconColor={props.iconColor}
                        pressableStyle={(pressed) => ([
                            props.styles.actionChip,
                            !props.showChipLabels ? props.styles.actionChipIconOnly : null,
                            pressed ? props.styles.actionChipPressed : null,
                            // Prefer wrapping the chip onto a new line over shrinking it to fit the current line.
                            // Still cap to the row width so extremely long IDs don't overflow horizontally.
                            { flexShrink: 0, maxWidth: '100%' },
                        ])}
                        textStyle={props.styles.actionChipText}
                    />
                ) : null}
                {trailingControls}
            </View>
        </View>
    );
}
