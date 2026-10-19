import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import {
    HAPPIER_TONE_COLOR_TOKEN,
    HappierProgress,
} from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SetupSteps, setupStepTestID, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
    resolvePluginTranscriptActivityCanDismiss,
    resolvePluginTranscriptActivityPresentation,
    type PluginTranscriptActivityItem,
} from './pluginTranscriptActivityPresentation';

const styles = StyleSheet.create({
    progress: {
        width: 72,
        flexShrink: 0,
    },
});

/**
 * Presentation-only Resource activity card. Its final transcript item already
 * contains only Session-admitted Actions, while opening one still delegates to
 * the canonical current Session controller. The card never creates a caller,
 * input, dispatcher, cache, or second admission decision.
 */
export const PluginTranscriptActivityCard = React.memo(
    function PluginTranscriptActivityCard(props: Readonly<{
        activity: PluginTranscriptActivityItem;
        onDismiss: (identityKey: string) => void;
        onOpenAction: (action: Readonly<{ pluginId: string; localId: string }>) => void;
    }>) {
        const { theme } = useUnistyles();
        const presentationTheme = usePluginUiTheme(theme);
        const canDismiss = resolvePluginTranscriptActivityCanDismiss(props.activity);
        const presentation = React.useMemo(
            () => resolvePluginTranscriptActivityPresentation(props.activity),
            [props.activity],
        );
        const checklistSteps = React.useMemo(() => presentation.checklistSteps.map((step): SetupStep => ({
            key: step.stepId,
            state: step.state,
            title: step.title,
            testID: setupStepTestID('plugin-transcript-activity-checklist-step', step.stepId, step.state),
        })), [presentation.checklistSteps]);
        if (props.activity.aggregateHiddenCount !== undefined) {
            return (
                <View testID="plugin-transcript-activity-overflow">
                    <ItemGroup title={t('common.more')}>
                        <Item
                            title={t('tools.common.more', { count: props.activity.aggregateHiddenCount })}
                            mode="info"
                            showChevron={false}
                            accessibilityRole="text"
                            accessibilityLabel={t('tools.common.more', { count: props.activity.aggregateHiddenCount })}
                        />
                    </ItemGroup>
                </View>
            );
        }
        return (
            <View testID="plugin-transcript-activity-card">
                {/* Counter updates stay visible and queryable on the progressbar; the
                    semantic transition key coalesces live announcements. */}
                <PoliteAccessibilityStatus
                    announcement={presentation.announcement}
                    statusTestID="plugin-transcript-activity-a11y-status"
                    transitionKey={presentation.announcementKey}
                />
                <ItemGroup title={props.activity.title}>
                    <Item
                        testID="plugin-transcript-activity-status"
                        title={presentation.statusTitle}
                        subtitle={presentation.statusDetail}
                        leftElement={(
                            <StatusDot
                                color={presentationTheme.colors[
                                    HAPPIER_TONE_COLOR_TOKEN[presentation.tone]
                                ]}
                                isPulsing={presentation.isPulsing}
                            />
                        )}
                        rightElement={presentation.progress ? (
                            <HappierProgress
                                testID="plugin-transcript-activity-progress"
                                label={presentation.accessibilityLabel}
                                value={presentation.progress.value}
                                theme={presentationTheme}
                                pointerEvents="none"
                                style={styles.progress}
                            />
                        ) : undefined}
                        mode="info"
                        showChevron={false}
                        accessibilityLabel={presentation.accessibilityLabel}
                    />
                    {checklistSteps.length > 0 ? (
                        <SectionContentRow testID="plugin-transcript-activity-checklist">
                            <SetupSteps variant="checklist" steps={checklistSteps} />
                        </SectionContentRow>
                    ) : null}
                    {props.activity.actions.map((action) => (
                        <Item
                            key={`${action.pluginId}:${action.localId}`}
                            testID={`plugin-transcript-activity-action:${action.localId}`}
                            title={action.label ?? action.localId}
                            onPress={() => props.onOpenAction({
                                pluginId: action.pluginId,
                                localId: action.localId,
                            })}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={action.label ?? action.localId}
                        />
                    ))}
                    {canDismiss ? (
                        <Item
                            testID="plugin-transcript-activity-dismiss"
                            title={t('session.pendingMessages.actions.dismiss')}
                            onPress={() => props.onDismiss(props.activity.identityKey)}
                            showChevron={false}
                            accessibilityRole="button"
                            accessibilityLabel={t('session.pendingMessages.actions.dismiss')}
                        />
                    ) : null}
                </ItemGroup>
            </View>
        );
    },
);
