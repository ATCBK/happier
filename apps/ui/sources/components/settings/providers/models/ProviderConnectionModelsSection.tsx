import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import type { TextInput } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { ProviderModelManager } from '@/providers/models/ProviderModelManager';
import { t } from '@/text';
import { ProviderErrorItems } from '../ProviderErrorItems';
import { ProviderManualModelsField } from '../ProviderManualModelsField';
import { ProviderReasoningEffortChips } from '../ProviderReasoningEffortField';
import type { ProviderConnectionModelsSectionState } from './useProviderConnectionModelsSection';

/**
 * A provider connection's Models page: its header above the filterable model list with a switch per
 * model. The page scrolls as one; only the model rows near the viewport mount.
 */
export function ProviderConnectionModelsPage(props: Readonly<{
    connectionId: string;
    models: ProviderConnectionModelsSectionState;
    header: React.ReactElement;
    footer: React.ReactElement;
    revealOnMount?: boolean;
    onRequestClose: () => void;
}>): React.ReactElement {
    const { models } = props;
    const { theme } = useUnistyles();
    const listed = models.modelCount > 0;
    const allowanceRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const contentState = !listed && models.initialLoading ? (
        <Item testID="provider-connection-models-loading" mode="info" loading title={t('common.loading')} />
    ) : !listed && models.error ? (
        <ProviderErrorItems
            error={models.error}
            retry={models.errorRetry}
            loadModel={models.errorLoadModel}
            reviewCurrentState={models.errorReviewCurrentState}
        />
    ) : null;
    const leadingRows = (
        <>
            {listed && models.error ? (
                <ProviderErrorItems
                    error={models.error}
                    retry={models.errorRetry}
                    loadModel={models.errorLoadModel}
                    reviewCurrentState={models.errorReviewCurrentState}
                />
            ) : null}
            {models.loadCancelledProviderMayContinue ? (
                <Item
                    mode="info"
                    title={t('settingsProviders.models.loadCancelled')}
                    subtitle={t('settingsProviders.models.loadCancelledProviderMayContinue')}
                />
            ) : null}
            {models.generationModel ? (
                <OutputAllowanceEditor models={models} fieldRef={allowanceRef} />
            ) : models.manualModelPolicy === 'allowed' ? (
                <InlineAddExpander
                    triggerTestID="provider-model-add"
                    isOpen={models.editorOpen}
                    onOpenChange={models.onEditorOpenChange}
                    title={t('settingsProviders.models.add')}
                    // Editing one model's tiers replaces the add row with just its form.
                    {...(models.editingModel ? { trigger: null } : { subtitle: t('settingsProviders.models.addDescription') })}
                    helpText={models.editorError ?? (models.editingModel
                        ? t('settingsProviders.models.editEffortHelp', { model: models.editingModel.name ?? models.editingModel.id })
                        : t('settingsProviders.models.addHelp'))}
                    onCancel={() => models.onEditorOpenChange(false)}
                    onSave={models.onSaveManualEditor}
                    saveDisabled={models.savingManualModels || (models.editingModel
                        ? !models.editingModelDirty
                        : !models.manualModelText.trim())}
                    cancelLabel={t('common.cancel')}
                    saveLabel={models.editingModel ? t('common.save') : t('settingsProviders.models.add')}
                    autoFocusRef={models.editingModel ? undefined : models.manualModelsRef}
                >
                    {models.editingModel ? (
                        <ProviderReasoningEffortChips
                            testID="provider-manual-model-effort"
                            levels={models.manualEffortLevels}
                            disabled={models.savingManualModels}
                            onChange={models.onManualEffortLevelsChange}
                        />
                    ) : (
                        <ProviderManualModelsField
                            ref={models.manualModelsRef}
                            value={models.manualModelText}
                            editable={!models.savingManualModels}
                            errorText={models.editorError}
                            onChangeText={models.onManualModelTextChange}
                            reasoningEffortLevels={models.manualEffortLevels}
                            onReasoningEffortLevelsChange={models.onManualEffortLevelsChange}
                        />
                    )}
                </InlineAddExpander>
            ) : models.manualModelPolicy === 'catalog-only' ? (
                <Item
                    mode="info"
                    title={t('settingsProviders.models.providerManagedTitle')}
                    subtitle={t('settingsProviders.models.providerManagedDescription')}
                />
            ) : null}
        </>
    );
    const listActions = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 }}>
            {models.canRefreshCatalog ? (
                <IconButton
                    testID="provider-model-catalog-refresh"
                    iconName="arrow-clockwise"
                    accessibilityLabel={t('common.refresh')}
                    tooltip={t('common.refresh')}
                    interactiveTargetGapPx={4}
                    variant="plain"
                    disabled={models.refreshingCatalog}
                    onPress={models.onRefreshCatalog}
                />
            ) : null}
            <IconButton
                testID="provider-model-show-hidden"
                iconName={models.showHidden ? 'eye-slash' : 'eye'}
                accessibilityLabel={models.showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                tooltip={models.showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                interactiveTargetGapPx={4}
                variant="plain"
                onPress={models.onToggleShowHidden}
            />
        </View>
    );

    return (
        <ProviderModelManager
            scope={{ kind: 'connection', connectionId: props.connectionId }}
            nativeModels={[]}
            groups={models.groups}
            showHidden={models.showHidden}
            onSetVisibility={models.onSetVisibility}
            // Show all is offered only while something is hidden (unknown counts keep it).
            onShowAll={models.catalogCount && models.catalogCount.shown >= models.catalogCount.total ? undefined : models.onShowAll}
            onHideAll={models.onHideAll}
            onResetVisibility={models.onResetVisibility}
            onShowOnly={models.onShowOnly}
            onLoadModel={models.onLoadModel}
            onCancelModelLoad={models.onCancelModelLoad}
            loadingModelKey={models.loadingModelKey}
            onRemoveManualModel={models.onRemoveManualModel}
            onEditManualModel={models.onEditManualModel}
            onEditGenerationSettings={models.onEditGenerationSettings}
            onRequestClose={props.onRequestClose}
            headerActions={listActions}
            testID="provider-connection-models"
            page={{
                header: props.header,
                footer: props.footer,
                // The page is "Models" (its header); the list's sheet needs no second title.
                title: '',
                leadingRows,
                contentState,
                summary: models.catalogCount
                    ? t('settingsProvidersCollection.modelsShown', models.catalogCount)
                    : null,
                revealOnMount: props.revealOnMount,
                testID: 'provider-connection-models-page',
            }}
        />
    );
}

/**
 * One model's generation settings: today its output allowance, an explicit number of tokens it may
 * write per reply. It opens in place of the add row, like the effort editor, and has no default.
 */
function OutputAllowanceEditor(props: Readonly<{
    models: ProviderConnectionModelsSectionState;
    fieldRef: React.RefObject<React.ElementRef<typeof TextInput> | null>;
}>): React.ReactElement | null {
    const { models } = props;
    const model = models.generationModel;
    if (!model) return null;
    const name = model.descriptor?.name ?? model.name ?? model.id;
    const usedByEditor = Boolean(model.descriptor?.inlineCompletion || model.descriptor?.nextEdit);
    const retained = models.retainedOutputAllowance;
    return (
        <InlineAddExpander
            triggerTestID="provider-model-generation"
            isOpen
            trigger={null}
            onOpenChange={models.onEditorOpenChange}
            title={t('settingsProviders.models.generationSettings')}
            helpText={t('settingsProviders.models.generationHelp', { model: name })}
            onCancel={() => models.onEditorOpenChange(false)}
            onSave={models.onSaveManualEditor}
            saveTestID="provider-model-generation-save"
            saveDisabled={models.savingManualModels || !models.outputAllowanceDirty}
            cancelLabel={t('common.cancel')}
            saveLabel={t('common.save')}
            autoFocusRef={props.fieldRef}
            extraActions={retained === null ? null : (
                <RoundButton
                    testID="provider-model-generation-clear"
                    display="secondary"
                    title={t('settingsProviders.models.outputAllowanceClear')}
                    accessibilityLabel={t('settingsProviders.models.outputAllowanceClear')}
                    disabled={models.savingManualModels}
                    onPress={models.onClearOutputAllowance}
                />
            )}
        >
            <FieldItem
                label={t('settingsProviders.models.outputAllowance')}
                labelNativeID="provider-model-output-allowance-label"
                supportingText={retained !== null
                    ? t('settingsProviders.models.outputAllowanceSaved', { tokens: retained.toLocaleString() })
                    : usedByEditor ? t('settingsProviders.models.outputAllowanceUnsetForEditor') : undefined}
            >
                <FieldTextInput
                    ref={props.fieldRef}
                    testID="provider-model-output-allowance"
                    accessibilityLabel={t('settingsProviders.models.outputAllowance')}
                    accessibilityLabelledBy="provider-model-output-allowance-label"
                    value={models.outputAllowanceValue}
                    placeholder={t('settingsProviders.models.outputAllowancePlaceholder')}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    monospace
                    editable={!models.savingManualModels}
                    error={models.editorError ?? undefined}
                    onChangeText={models.onOutputAllowanceChange}
                    onSubmitEditing={models.onSaveManualEditor}
                />
            </FieldItem>
        </InlineAddExpander>
    );
}
