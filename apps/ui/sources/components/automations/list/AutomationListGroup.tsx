import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AutomationDefinition } from '@/sync/domains/automations/automationTypes';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { createAdmittedWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import {
    formatAutomationNextRun,
    formatAutomationTriggerLabel,
    formatAutomationTriggerStatusLabel,
} from './automationListFormatting';
import type { AutomationRunNowController } from './useAutomationRunNowController';
import type { ItemGroupVirtualizedSegment } from '@/components/ui/lists/ItemGroup.dividers';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { formatAutomationErrorMessage } from '@/components/automations/automationErrorFormatting';
import { motionTokens } from '@/components/ui/motion/motionTokens';

// The drawn control height, grown to the touch floor where the primary pointer is a finger.
const minimumInteractiveTargetSize = Math.max(HAPPIER_PAGE_METRICS.controlHeightPx, resolveMinimumInteractiveTargetSize(Platform.OS));
const MAX_VISIBLE_TRIGGER_SUMMARY_LINES = 3;

type Props = Readonly<{
    title?: string;
    automations: ReadonlyArray<Pick<AutomationDefinition, 'id' | 'name' | 'enabled' | 'triggers' | 'targetType'>>;
    onOpenAutomation?: (automationId: string) => void;
    /** Parent read currentness gates only mutations; list navigation remains available. */
    mutationsEnabled?: boolean;
    /**
     * Run-now pending state lives with the screen so it survives virtualized
     * row recycling; this group only presents it.
     */
    runNow: AutomationRunNowController;
    /** Route/account lifetime witness captured by the owning screen. */
    isInvocationCurrent: () => boolean;
    /** Joins independently virtualized chunks into one logical group surface. */
    virtualizedSegment?: ItemGroupVirtualizedSegment;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    rowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    runNowButton: {
        width: minimumInteractiveTargetSize,
        height: minimumInteractiveTargetSize,
        borderRadius: minimumInteractiveTargetSize / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
}));

export const AutomationListGroup = React.memo((props: Props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const runNowController = props.runNow;
    const mutationsEnabled = props.mutationsEnabled !== false;
    const enabledMutationIdsRef = React.useRef(new Set<string>());
    const [enabledMutationIds, setEnabledMutationIds] = React.useState<ReadonlySet<string>>(() => new Set());

    const handleRunNow = React.useCallback(async (
        automationId: string,
        targetType: AutomationDefinition['targetType'],
    ) => {
        if (!mutationsEnabled) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        const admitted = await runNowController.runNow(automationId, targetType, {
            isInvocationCurrent: props.isInvocationCurrent,
        });
        // Only the server's declared correspondence opens a managed Run. A
        // legacy receipt keeps the incumbent acknowledgement-in-place behaviour.
        const route = createAdmittedWorkflowRunRoute(admitted?.workflowRun, lifetime?.scope.serverId);
        if (route === null || !props.isInvocationCurrent()) return;
        navigateWithBlurOnWeb(() => router.push(route as never));
    }, [mutationsEnabled, props.isInvocationCurrent, router, runNowController]);

    const handleSetEnabled = React.useCallback(async (automationId: string, nextEnabled: boolean) => {
        if (
            !mutationsEnabled
            || !props.isInvocationCurrent()
            || enabledMutationIdsRef.current.has(automationId)
        ) return;
        enabledMutationIdsRef.current.add(automationId);
        setEnabledMutationIds(new Set(enabledMutationIdsRef.current));
        try {
            if (!nextEnabled) {
                await sync.pauseAutomation(automationId);
            } else {
                await sync.resumeAutomation(automationId);
            }
        } catch (error) {
            if (!props.isInvocationCurrent()) return;
            await Modal.alert(
                t('common.error'),
                formatAutomationErrorMessage(error, t('automations.edit.updateFailed')),
            );
        } finally {
            enabledMutationIdsRef.current.delete(automationId);
            setEnabledMutationIds(new Set(enabledMutationIdsRef.current));
        }
    }, [mutationsEnabled, props.isInvocationCurrent]);

    const openAutomation = React.useCallback((automationId: string) => {
        if (props.onOpenAutomation) {
            navigateWithBlurOnWeb(() => props.onOpenAutomation?.(automationId));
            return;
        }
        navigateWithBlurOnWeb(() => router.push(`/automations/${automationId}` as any));
    }, [props, router]);

    return (
        <ItemGroup
            {...(props.title === undefined ? {} : { title: props.title })}
            {...(props.virtualizedSegment === undefined
                ? {}
                : { virtualizedSegment: props.virtualizedSegment })}
        >
            {props.automations.map((automation) => {
                const runState = runNowController.stateFor(automation.id);
                const runNowPending = runState === 'submitting';
                const runNowDisabled = !mutationsEnabled || runNowPending;
                const enabledMutationPending = enabledMutationIds.has(automation.id);
                const triggerLines = automation.triggers.length === 0
                    ? [t('automations.list.noAutomaticTriggers')]
                    : automation.triggers.slice(0, MAX_VISIBLE_TRIGGER_SUMMARY_LINES).map((trigger) => [
                        formatAutomationTriggerLabel(trigger),
                        formatAutomationTriggerStatusLabel(trigger, automation.enabled),
                        ...(automation.enabled
                            && trigger.kind === 'pluginEvent'
                            && trigger.sourceCatalogStatus !== null
                            && trigger.sourceCatalogStatus.state !== 'current'
                            ? [t(`settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.${trigger.sourceCatalogStatus.state}`)]
                            : []),
                        ...(trigger.kind === 'schedule' ? [formatAutomationNextRun(trigger.nextRunAt)] : []),
                    ].join(' · '));
                const hiddenTriggerCount = Math.max(
                    0,
                    automation.triggers.length - MAX_VISIBLE_TRIGGER_SUMMARY_LINES,
                );
                const subtitle = [
                    ...triggerLines,
                    ...(hiddenTriggerCount > 0
                        ? [t('automations.list.moreTriggers', { count: hiddenTriggerCount })]
                        : []),
                ].join('\n');

                return (
                    <Item
                        key={automation.id}
                        title={automation.name}
                        subtitle={subtitle}
                        subtitleLines={0}
                        onPress={() => openAutomation(automation.id)}
                        rightElementOutsidePressable
                        rightElement={(
                            <View style={styles.rowRight}>
                                <Pressable
                                    onPress={mutationsEnabled
                                        ? () => void handleRunNow(automation.id, automation.targetType)
                                        : undefined}
                                    style={({ pressed }) => ([
                                        styles.runNowButton,
                                        { opacity: runNowDisabled ? 0.5 : pressed ? motionTokens.press.opacity : 1 },
                                    ])}
                                    disabled={runNowDisabled}
                                    accessibilityRole="button"
                                    accessibilityLabel={runState === 'acknowledged'
                                        ? `${t('automations.detail.runNowTitle')}: ${automation.name}. ${t('common.success')}`
                                        : `${t('automations.detail.runNowTitle')}: ${automation.name}`}
                                    accessibilityState={{ disabled: runNowDisabled, busy: runNowPending }}
                                    accessibilityLiveRegion={runState === 'acknowledged' ? 'polite' : undefined}
                                    {...(runState === 'acknowledged'
                                        ? ({ 'aria-live': 'polite' } as Record<string, unknown>)
                                        : {})}
                                >
                                    {runState === 'submitting' ? (
                                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                    ) : runState === 'acknowledged' ? (
                                        <Icon name="check" size={16} color={theme.colors.text.secondary} />
                                    ) : (
                                        <Icon name="play" size={16} color={theme.colors.text.secondary} />
                                    )}
                                </Pressable>
                                <Switch
                                    value={automation.enabled}
                                    onValueChange={mutationsEnabled
                                        ? (next) => void handleSetEnabled(automation.id, next)
                                        : undefined}
                                    disabled={!mutationsEnabled || enabledMutationPending}
                                    accessibilityLabel={[
                                        automation.name,
                                        t(automation.enabled
                                            ? 'automations.detail.pauseAutomation'
                                            : 'automations.detail.resumeAutomation'),
                                    ].join('. ')}
                                    accessibilityState={{
                                        disabled: !mutationsEnabled || enabledMutationPending,
                                        busy: enabledMutationPending,
                                    }}
                                />
                            </View>
                        )}
                        showChevron={false}
                    />
                );
            })}
        </ItemGroup>
    );
});
