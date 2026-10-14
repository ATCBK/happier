import * as React from 'react';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import { useViewportClass } from '@/utils/platform/useViewportClass';

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
    modelChoices?: ReturnType<typeof useScmDiffSummaryModelChoices>;
    testID?: string;
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
    React.useEffect(() => { props.onAvailabilityChange?.(choices.selectionAvailable); }, [props.onAvailabilityChange, choices.selectionAvailable]);
    return <DropdownMenu open={choices.open} onOpenChange={choices.setOpen} items={choices.items} selectedId={choices.selectedItem?.id ?? props.value} search searchPlaceholder={t('walkthroughSettings.searchModels')}
        variant="selectable" matchTriggerWidth connectToTrigger closeOnSelect={false} showCategoryTitles categoryDecorations={choices.sections}
        itemTrigger={{ title: t('walkthroughSettings.model'), subtitle: t('walkthroughSettings.modelDescription'),
            // A chosen model that cannot be used explains itself in the row once; otherwise the row keeps what the model is for.
            showSelectedSubtitle: choices.selectedItem?.disabled === true,
            detailFormatter: () => props.value === '' && choices.defaultProfile && choices.selections.has('')
                ? `${choices.defaultProfile.title} · ${t('walkthroughSettings.defaultModel')}`
                : choices.selectedItem?.title ?? (props.value ? t('walkthroughSettings.unavailable') : props.defaultBackendTarget && choices.selections.has('') ? t('agentInput.model.useCliSettings') : t('walkthroughSettings.chooseModel')),
            itemProps: { testID: props.testID ?? 'walkthrough.summaryModel', subtitleLines: 0,
                accessoryLayout: viewportClass === 'compact' ? 'stacked' : 'adaptive' } }}
        onSelect={(id) => {
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
