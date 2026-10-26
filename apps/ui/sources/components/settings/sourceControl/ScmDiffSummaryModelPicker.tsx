import * as React from 'react';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { SCM_SUMMARY_CATALOG_NOTICE_ITEM_ID, SCM_SUMMARY_GROUPED_AGENTS_RETRY_ITEM_ID } from '@/components/settings/pickers/useAgentModelChoices';
import { useScmDiffSummaryModelChoices, type ScmDiffSummaryModelSelection } from './useScmDiffSummaryModelChoices';
export type { ScmDiffSummaryModelSelection } from './useScmDiffSummaryModelChoices';

type ScmDiffSummaryModelPickerProps = Readonly<{
    value: string;
    onChange: (value: string) => void;
    onSelection?: (selection: ScmDiffSummaryModelSelection) => void;
    onAvailabilityChange?: (available: boolean) => void;
    machineId?: string | null;
    serverId?: string | null;
    defaultBackendTarget?: BackendTargetRefV2 | null;
    /**
     * What an unset choice runs on when no default model can be named here, such as the hosting Session's own model.
     * Without it an unset choice reads "Choose a model".
     */
    unsetLabel?: string | null;
    modelChoices?: ReturnType<typeof useScmDiffSummaryModelChoices>;
    testID?: string;
    /**
     * `row` is the settings row. `inline` is one quiet line ("Summary model  Haiku 4.5") for a choice that sits with
     * the action it affects; the choices and menu are the same.
     */
    presentation?: 'row' | 'inline';
}>;

/** The picker consumes its result binding's observation, or observes directly in Settings. */
export function ScmDiffSummaryModelPicker(props: ScmDiffSummaryModelPickerProps): React.ReactElement {
    return props.modelChoices ? <ModelPickerChoices {...props} modelChoices={props.modelChoices} /> : <ObservedModelPicker {...props} />;
}

function ObservedModelPicker(props: ScmDiffSummaryModelPickerProps) {
    const modelChoices = useScmDiffSummaryModelChoices(props);
    return <ModelPickerChoices {...props} modelChoices={modelChoices} />;
}

function ModelPickerChoices(props: ScmDiffSummaryModelPickerProps & Readonly<{ modelChoices: ReturnType<typeof useScmDiffSummaryModelChoices> }>) {
    const choices = props.modelChoices;
    const viewportClass = useViewportClass();
    const { theme } = useUnistyles();
    React.useEffect(() => { props.onAvailabilityChange?.(choices.selectionAvailable); }, [props.onAvailabilityChange, choices.selectionAvailable]);
    const detail = props.value === '' && choices.defaultProfile && choices.selections.has('')
        ? `${choices.defaultProfile.title} · ${t('walkthroughSettings.defaultModel')}`
        : choices.selectedItem?.title ?? (props.value ? t('walkthroughSettings.unavailable') : props.unsetLabel ? props.unsetLabel : props.defaultBackendTarget && choices.selections.has('') ? t('agentInput.model.useCliSettings') : t('walkthroughSettings.chooseModel'));
    const inline = props.presentation === 'inline';
    const rowTrigger = { itemTrigger: { title: t('walkthroughSettings.model'), subtitle: t('walkthroughSettings.modelDescription'),
        // A chosen model that cannot be used explains itself in the row once; otherwise the row keeps what the model is for.
        showSelectedSubtitle: choices.selectedItem?.disabled === true,
        detailFormatter: () => detail,
        itemProps: { testID: props.testID ?? 'walkthrough.summaryModel', subtitleLines: 0,
            accessoryLayout: viewportClass === 'compact' ? 'stacked' as const : 'adaptive' as const } } };
    const inlineTrigger = { matchTriggerWidth: false, connectToTrigger: false,
        trigger: ({ toggle, open }: Readonly<{ toggle: () => void; open: boolean }>) => (
            <HappierPressable testID={props.testID ?? 'walkthrough.summaryModel'} accessibilityRole="button"
                accessibilityLabel={`${t('walkthroughSettings.model')}: ${detail}`} expanded={open} onPress={toggle}
                style={({ pressed, hovered }) => [styles.inlineTrigger, hovered || pressed || open ? styles.inlineTriggerActive : null]}>
                <Text style={styles.inlineLabel}>{t('walkthroughSettings.model')}</Text>
                <Text style={styles.inlineValue} numberOfLines={1}>{detail}</Text>
                <Icon name={open ? 'caret-up' : 'caret-down'} size={12} color={theme.colors.text.tertiary} />
            </HappierPressable>
        ) };
    return <DropdownMenu open={choices.open} onOpenChange={choices.setOpen} items={choices.items} selectedId={choices.selectedItem?.id ?? props.value} search searchPlaceholder={t('walkthroughSettings.searchModels')} emptyLabel={choices.emptyLabel}
        variant="selectable" closeOnSelect={false} showCategoryTitles categoryDecorations={choices.sections}
        {...(inline ? inlineTrigger : { matchTriggerWidth: true, connectToTrigger: true, ...rowTrigger })}
        onSelect={(id) => {
            if (choices.items.find(item => item.id === id)?.disabled) return;
            if (id === SCM_SUMMARY_CATALOG_NOTICE_ITEM_ID || id === SCM_SUMMARY_GROUPED_AGENTS_RETRY_ITEM_ID) { choices.onRefresh?.(); return; }
            const discoveryTarget = choices.discoveryTargets.get(id);
            if (discoveryTarget) {
                if (!props.machineId) return;
                choices.setDiscoveryTargetKey(discoveryTarget); choices.setOpen(true);
                if (discoveryTarget === choices.discoveryTargetKey) choices.onRefresh?.();
                return;
            }
            const selection = choices.selections.get(id);
            if (!selection) return;
            // Choosing the default row returns to following the default rather than writing its id.
            props.onChange(id === choices.defaultProfile?.catalogId ? '' : id); props.onSelection?.(selection); choices.setDiscoveryTargetKey(null); choices.setOpen(false);
        }} />;
}

const styles = StyleSheet.create((theme) => ({
    inlineTrigger: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        gap: theme.space.s6,
        minHeight: 32,
        paddingHorizontal: theme.space.s10,
        borderRadius: 8,
    },
    inlineTriggerActive: { backgroundColor: theme.colors.surface.selected },
    inlineLabel: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    inlineValue: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.secondary, flexShrink: 1 },
}));
