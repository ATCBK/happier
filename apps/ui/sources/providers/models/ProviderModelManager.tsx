import * as React from 'react';
import { Platform, View } from 'react-native';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { readProviderReasoningEffortOption } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { serializeModelVisibilityRefV1, type ModelVisibilityRefV1, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type {
    DaemonProviderModelProjectionGroupV1,
    DaemonProviderModelProjectionRowV1,
} from '@happier-dev/protocol/rpc';

import { Switch } from '@/components/ui/forms/Switch';
import { FavoriteToggleButton } from '@/components/ui/buttons/FavoriteToggleButton';
import type { FavoriteProviderDisplaySnapshot } from '@/sync/domains/models/favoriteModelSelections';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { useDeviceType } from '@/utils/platform/responsive';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { useItemRowHovered } from '@/components/ui/lists/ItemRowHover';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
    SelectionListScreen,
    type SelectionListOption,
    type SelectionListSection,
} from '@/components/ui/selectionList';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { t } from '@/text';
import { providerModelRowKey } from './modelRowKey';
import { MODEL_ROWS_PER_SEGMENT, ProviderModelManagerPage, type ProviderModelManagerPageHost } from './ProviderModelManagerPage';
import { presentProviderModelRow, presentProviderSourceStatus } from './presentProviderModelRow';
import { providerModelConnectionTitle } from './providerModelConnectionTitle';

type ProviderModelManagerRow = Readonly<{
    ref: Pick<DaemonProviderModelProjectionRowV1['ref'], 'modelId'>;
    descriptor: Pick<DaemonProviderModelProjectionRowV1['descriptor'], 'id' | 'name' | 'description' | 'contextWindowTokens' | 'capabilities' | 'modelOptions'>;
    sources: DaemonProviderModelProjectionRowV1['sources'];
    compatibility?: DaemonProviderModelProjectionRowV1['compatibility'];
    endpointHealth?: DaemonProviderModelProjectionRowV1['endpointHealth'];
    confidence?: DaemonProviderModelProjectionRowV1['confidence'];
    catalog: DaemonProviderModelProjectionRowV1['catalog'];
    loadState: DaemonProviderModelProjectionRowV1['loadState'];
    visibility: DaemonProviderModelProjectionRowV1['visibility'];
}>;

/**
 * Context-neutral model-management view. Agent projections satisfy this
 * contract structurally; connection catalogs adapt only facts they own and do
 * not fabricate an agent target or session-current selection.
 */
export type ProviderModelManagerGroup = Readonly<{
    connectionId: string;
    providerName: string;
    connectionName: string;
    connectionRole: DaemonProviderModelProjectionGroupV1['connectionRole'];
    connectionDisplayNameMode: DaemonProviderModelProjectionGroupV1['connectionDisplayNameMode'];
    modelLoadAction: DaemonProviderModelProjectionGroupV1['modelLoadAction'];
    authorization?: DaemonProviderModelProjectionGroupV1['authorization'];
    rows: readonly ProviderModelManagerRow[];
}>;

function ModelVisibilityAccessory(props: Readonly<{
    label: string;
    visible: boolean;
    disabled: boolean;
    isFavorite?: boolean;
    /** What the catalog says about the model's context window; never estimated. */
    contextLabel?: string;
    /** The star. Without it a favorite is only drawn, never toggled. */
    onToggleFavorite?: () => void;
    onSetDefault?: () => void;
    onVisibleChange: (visible: boolean) => void;
    onRemove?: () => void;
    onEditEffort?: () => void;
    onEditGeneration?: () => void;
    onShowOnly?: () => void;
    onLoad?: () => void;
    onCancelLoad?: () => void;
    loading?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // On a phone the star and the switch keep the room; the context size drops out.
    const showContext = useDeviceType() !== 'phone';
    // The row menu holds rare operations: with a pointer it appears when the row (or the menu itself,
    // or keyboard focus inside it) is engaged; on touch it is always there.
    const rowHovered = useItemRowHovered();
    const [menuEngaged, setMenuEngaged] = React.useState(false);
    const revealMenu = Platform.OS !== 'web' || rowHovered || menuEngaged;
    const menuEngagement = Platform.OS === 'web' ? {
        onMouseEnter: () => setMenuEngaged(true),
        onMouseLeave: () => setMenuEngaged(false),
        onFocus: () => setMenuEngaged(true),
        onBlur: () => setMenuEngaged(false),
    } : undefined;
    const actionLabel = (action: string) => `${props.label}, ${action}`;
    // Three intentions, three controls: the star pins, the switch shows or hides, the Default tag
    // (beside the name) marks where new sessions start. Rare operations share one row menu.
    const menuActions: PageHeaderMenuAction[] = [
        ...(props.onSetDefault ? [{
            id: 'setDefault',
            testID: 'provider-model-manager.set-default',
            title: t('connectedServices.detail.actions.setDefault'),
            onSelect: props.onSetDefault,
        }] : []),
        ...(props.onShowOnly ? [{
            id: 'showOnly',
            testID: 'provider-model-manager.show-only',
            title: t('settingsProviders.models.showOnly'),
            onSelect: props.onShowOnly,
        }] : []),
        ...(props.onEditEffort ? [{
            id: 'editEffort',
            testID: 'provider-model-manager.edit-effort',
            title: t('settingsProviders.models.editEffort'),
            onSelect: props.onEditEffort,
        }] : []),
        ...(props.onEditGeneration ? [{
            id: 'editGeneration',
            testID: 'provider-model-manager.edit-generation',
            title: t('settingsProviders.models.generationSettings'),
            onSelect: props.onEditGeneration,
        }] : []),
        ...(props.onRemove ? [{
            id: 'remove',
            testID: 'provider-model-manager.remove',
            title: t('settingsProviders.models.remove'),
            destructive: true,
            onSelect: props.onRemove,
        }] : []),
    ];
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {showContext && props.contextLabel ? (
                <Text testID="provider-model-manager.context" style={[styles.contextLabel, { color: theme.colors.text.secondary }]}>
                    {props.contextLabel}
                </Text>
            ) : null}
            {props.onToggleFavorite ? (
                <FavoriteToggleButton
                    testID="provider-model-manager.favorite"
                    id={props.label}
                    isFavorite={props.isFavorite === true}
                    addLabel={actionLabel(t('profiles.actions.addToFavorites'))}
                    removeLabel={actionLabel(t('profiles.actions.removeFromFavorites'))}
                    onToggle={props.onToggleFavorite}
                />
            ) : props.isFavorite ? (
                <View
                    testID="provider-model-manager.favorite"
                    accessible
                    accessibilityLabel={t('settingsAgents.detailPage.modelsLegendFavorite')}
                >
                    <Icon name="star" weight="fill" size={14} color={theme.colors.state.warning.foreground} />
                </View>
            ) : null}
            {props.onCancelLoad ? (
                <IconButton
                    testID="provider-model-manager.cancel-load"
                    iconName="x-circle"
                    accessibilityLabel={actionLabel(t('settingsProviders.models.cancelLoad'))}
                    tooltip={t('settingsProviders.models.cancelLoad')}
                    interactiveTargetGapPx={6}
                    variant="plain"
                    onPress={props.onCancelLoad}
                />
            ) : null}
            {props.onLoad ? (
                <IconButton
                    testID="provider-model-manager.load"
                    iconName="cloud-arrow-down"
                    accessibilityLabel={actionLabel(t('settingsProviders.models.load'))}
                    tooltip={t('settingsProviders.models.load')}
                    interactiveTargetGapPx={6}
                    variant="plain"
                    disabled={props.loading}
                    onPress={props.onLoad}
                />
            ) : null}
            {menuActions.length > 0 ? (
                <View {...menuEngagement} style={revealMenu ? undefined : styles.menuQuiet}>
                    <PageHeaderMenu
                        testID="provider-model-manager.row-menu"
                        accessibilityLabel={actionLabel(t('common.moreActions'))}
                        actions={menuActions}
                    />
                </View>
            ) : null}
            <Switch
                compact
                value={props.visible}
                disabled={props.disabled}
                accessibilityLabel={props.label}
                onValueChange={props.onVisibleChange}
            />
        </View>
    );
}

/** "Default": the model new sessions start on. Never shares a control with showing or hiding it. */
function ModelDefaultTag(): React.ReactElement {
    return <StatusPill testID="provider-model-manager.default" variant="info" hideDot label={t('settingsAgents.detailPage.modelsDefaultTag')} />;
}

/**
 * In a source hidden from the picker, the one model the picker still offers says why, where its
 * switch would be: it is a favorite (the star stays), or it is where new sessions start.
 */
function ModelStaysVisible(props: Readonly<{ favorite: boolean }>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View testID="provider-model-manager.stays-visible" style={styles.staysVisible}>
            <Text style={[styles.staysVisibleText, { color: theme.colors.text.secondary }]}>
                {t(props.favorite
                    ? 'settingsAgents.detailPage.modelsStaysVisibleFavorite'
                    : 'settingsAgents.detailPage.modelsStaysVisibleDefault')}
            </Text>
            {props.favorite ? (
                <Icon name="star" weight="fill" size={14} color={theme.colors.state.warning.foreground} />
            ) : null}
        </View>
    );
}

/**
 * One sheet per model source, in picker order (Agent → Models): the agent's own models, then each
 * Provider connection. Hidden models stay listed in their source with their switch off.
 */
export type ProviderModelManagerSourceGrouping = Readonly<{
    nativeTitle: string;
    nativeDescription: string;
    connectionDescription: string;
    /** The agent's default model, tagged where it is listed. */
    defaultRef: Readonly<{ providerConnectionId: string | null; modelId: string }> | null;
    favoriteRefs?: readonly ProviderBoundModelRef[];
    /** Pins or unpins a model; the page that owns Account favorites supplies it. */
    onToggleFavorite?: (input: Readonly<{
        ref: ProviderBoundModelRef;
        modelLabel: string;
        providerDisplaySnapshot: FavoriteProviderDisplaySnapshot | null;
    }>) => void;
    onSetDefault?: (ref: ProviderBoundModelRef) => void;
    /**
     * A source's own control in its header: the Account-wide "Show in model picker" switch that the
     * R1 owner supplies. Nothing is drawn for a source it does not answer.
     */
    renderSourceAccessory?: (connectionId: string) => React.ReactNode;
    /** The identity marks that lead each source's header: the agent's own, then each Provider's. */
    nativeMark?: React.ReactNode;
    renderSourceMark?: (connectionId: string) => React.ReactNode;
    /**
     * Whether the picker shows a source (its "Show in model picker" switch). A hidden source collapses
     * to its header, the favorites and default the picker still offers, and a way to browse it.
     * Unanswered (null or absent) reads as shown.
     */
    isSourceShown?: (connectionId: string) => boolean | null;
}>;

/** A section as the page draws it: a source sheet may lead with its description and control. */
export type ProviderModelManagerSection = SelectionListSection & Readonly<{
    description?: string;
    mark?: React.ReactNode;
    headerAccessory?: React.ReactNode;
    /** A destination closing the source's sheet ("Browse 312 models"). */
    footerAction?: Readonly<{ label: string; onPress: () => void }>;
}>;

export type ProviderModelManagerScope =
    | Readonly<{ kind: 'agent'; agentTargetKey: string }>
    | Readonly<{ kind: 'connection'; connectionId: string }>;

export type ProviderModelManagerNativeModel = Readonly<{
    id: string;
    name: string;
    description?: string;
    contextWindowTokens?: number;
    hidden: boolean;
}>;

export type ProviderModelVisibilityChange = Readonly<{
    ref: ModelVisibilityRefV1;
    hidden: boolean;
}>;

const EMPTY_NATIVE_MODELS: readonly ProviderModelManagerNativeModel[] = [];
const EMPTY_GROUPS: readonly ProviderModelManagerGroup[] = [];

function ProviderModelBulkActions(props: Readonly<{
    onShowAll?: () => void;
    onHideAll?: () => void;
    onReset?: () => void;
}>): React.ReactElement | null {
    if (!props.onShowAll && !props.onHideAll && !props.onReset) return null;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {props.onShowAll ? (
                <IconButton
                    testID="provider-model-manager.show-all"
                    iconName="eye"
                    accessibilityLabel={t('settingsProviders.models.showAll')}
                    tooltip={t('settingsProviders.models.showAll')}
                    interactiveTargetGapPx={4}
                    variant="plain"
                    onPress={props.onShowAll}
                />
            ) : null}
            {props.onHideAll ? (
                <IconButton
                    testID="provider-model-manager.hide-all"
                    iconName="eye-slash"
                    accessibilityLabel={t('settingsProviders.models.hideAll')}
                    tooltip={t('settingsProviders.models.hideAll')}
                    interactiveTargetGapPx={4}
                    variant="plain"
                    onPress={props.onHideAll}
                />
            ) : null}
            {props.onReset ? (
                <IconButton
                    testID="provider-model-manager.reset"
                    iconName="arrow-clockwise"
                    accessibilityLabel={t('settingsProviders.models.resetVisibility')}
                    tooltip={t('settingsProviders.models.resetVisibility')}
                    interactiveTargetGapPx={4}
                    variant="plain"
                    onPress={props.onReset}
                />
            ) : null}
        </View>
    );
}

export function buildProviderModelVisibilityChanges(input: Readonly<{
    scope: ProviderModelManagerScope;
    nativeModels: readonly ProviderModelManagerNativeModel[];
    groups: readonly ProviderModelManagerGroup[];
    action: 'showAll' | 'hideAll' | 'showOnly';
    selected?: ModelVisibilityRefV1;
}>): readonly ProviderModelVisibilityChange[] {
    const refs: ModelVisibilityRefV1[] = [];
    if (input.scope.kind === 'agent') {
        for (const model of input.nativeModels) {
            refs.push({
                scope: 'agent',
                agentTargetKey: input.scope.agentTargetKey,
                providerConnectionId: null,
                modelId: model.id,
            });
        }
    }
    for (const group of input.groups) {
        if (input.scope.kind === 'connection' && group.connectionId !== input.scope.connectionId) continue;
        const connectionId = ProviderConnectionIdSchema.parse(group.connectionId);
        for (const row of group.rows) {
            refs.push(input.scope.kind === 'agent'
                ? {
                    scope: 'agent',
                    agentTargetKey: input.scope.agentTargetKey,
                    providerConnectionId: connectionId,
                    modelId: row.ref.modelId,
                }
                : {
                    scope: 'allAgents',
                    providerConnectionId: connectionId,
                    modelId: row.ref.modelId,
                });
        }
    }
    const selectedKey = input.selected ? serializeModelVisibilityRefV1(input.selected) : null;
    if (input.action === 'showOnly' && selectedKey === null) return [];
    if (input.action === 'showOnly'
        && !refs.some((ref) => serializeModelVisibilityRefV1(ref) === selectedKey)) return [];
    return refs.map((ref) => ({
        ref,
        hidden: input.action === 'hideAll'
            || (input.action === 'showOnly' && serializeModelVisibilityRefV1(ref) !== selectedKey),
    }));
}


/** The tiers a model declares, named by the shared descriptor; null when it declares none. */
function reasoningEffortLevelsLabel(descriptor: ProviderModelManagerRow['descriptor']): string | undefined {
    const option = readProviderReasoningEffortOption(descriptor);
    return option?.options?.map(level => level.name).join(', ');
}

function modelVisibilityActionLabel(hidden: boolean): string {
    return hidden
        ? t('settingsProviders.models.enable')
        : t('settingsProviders.models.disable');
}

export function buildProviderModelManagerSections(input: Readonly<{
    scope: ProviderModelManagerScope;
    nativeModels: readonly ProviderModelManagerNativeModel[];
    groups: readonly ProviderModelManagerGroup[];
    showHidden: boolean;
    readOnly?: boolean;
    onSetVisibility: (ref: ModelVisibilityRefV1, hidden: boolean) => void;
    onRemoveManualModel?: (connectionId: string, modelId: string) => void;
    onEditManualModel?: (connectionId: string, modelId: string) => void;
    onEditGenerationSettings?: (connectionId: string, modelId: string) => void;
    onShowOnly?: (ref: ModelVisibilityRefV1) => void;
    onLoadModel?: (connectionId: string, modelId: string) => void;
    onCancelModelLoad?: () => void;
    onOpenConnection?: (connectionId: string) => void;
    loadingModelKey?: string | null;
    grouping?: ProviderModelManagerSourceGrouping;
}>): readonly ProviderModelManagerSection[] {
    const agentScope = input.scope.kind === 'agent' ? input.scope : null;
    const grouping = agentScope ? input.grouping : undefined;
    // Grouped by source, a hidden model stays in its source with its switch off.
    const showHidden = input.showHidden || grouping !== undefined;
    const defaultRef = grouping?.defaultRef ?? null;
    const isDefault = (providerConnectionId: string | null, modelId: string) => defaultRef !== null
        && defaultRef.providerConnectionId === providerConnectionId
        && defaultRef.modelId === modelId;
    const favoriteKeys = new Set(grouping?.favoriteRefs?.filter(ref => ref.agentTargetKey === agentScope?.agentTargetKey)
        .map(ref => providerModelRowKey(ref.providerConnectionId ?? '', ref.modelId)));
    const isFavorite = (providerConnectionId: string | null, modelId: string) => favoriteKeys.has(
        providerModelRowKey(providerConnectionId ?? '', modelId),
    );
    const nativeOptions: SelectionListOption[] = [];
    const sourceSections: ProviderModelManagerSection[] = [];
    const availableOptions: SelectionListOption[] = [];
    const hiddenOptions: SelectionListOption[] = [];
    const manualOptions: SelectionListOption[] = [];
    if (agentScope) {
        for (const model of input.nativeModels) {
            if (model.hidden && !showHidden) continue;
            const ref: ModelVisibilityRefV1 = {
                scope: 'agent', agentTargetKey: agentScope.agentTargetKey,
                providerConnectionId: null, modelId: model.id,
            };
            const option = {
                id: `native:${model.id}`,
                label: model.name,
                ...(isDefault(null, model.id) ? { titleAccessory: <ModelDefaultTag /> } : {}),
                disabled: input.readOnly === true,
                // Grouped by source, a row is one line: the name, tags and controls.
                ...(grouping ? {} : { subtitle: model.description ?? model.id }),
                accessibilityLabel: `${model.name}, ${modelVisibilityActionLabel(model.hidden)}`,
                rightAccessoryOutsidePressable: true,
                rightAccessory: (
                    <ModelVisibilityAccessory
                        label={model.name}
                        visible={!model.hidden}
                        disabled={input.readOnly === true}
                        isFavorite={isFavorite(null, model.id)}
                        contextLabel={model.contextWindowTokens ? formatTokenCount(model.contextWindowTokens) : undefined}
                        onToggleFavorite={!input.readOnly && grouping?.onToggleFavorite
                            ? () => grouping.onToggleFavorite?.({
                                ref: { agentTargetKey: agentScope.agentTargetKey, providerConnectionId: null, modelId: model.id },
                                modelLabel: model.name,
                                providerDisplaySnapshot: null,
                            })
                            : undefined}
                        onSetDefault={!input.readOnly && !isDefault(null, model.id) && grouping?.onSetDefault
                            ? () => grouping.onSetDefault?.({ agentTargetKey: agentScope.agentTargetKey, providerConnectionId: null, modelId: model.id })
                            : undefined}
                        onVisibleChange={(visible) => input.onSetVisibility(ref, !visible)}
                    />
                ),
                onSelect: input.readOnly ? undefined : () => input.onSetVisibility(ref, !model.hidden),
            };
            if (grouping) nativeOptions.push(option);
            else (model.hidden ? hiddenOptions : availableOptions).push(option);
        }
    }

    for (const group of input.groups) {
        if (input.scope.kind === 'connection' && group.connectionId !== input.scope.connectionId) continue;
        const connectionId = ProviderConnectionIdSchema.parse(group.connectionId);
        const groupOptions: SelectionListOption[] = [];
        const sourceHidden = grouping?.isSourceShown?.(group.connectionId) === false;
        // A source too long for one page segment lists only what the picker pins (favorites and
        // the default) and leads to the rest; its own page owns filtering.
        const collapsedSource = sourceHidden || (grouping !== undefined && group.rows.length > MODEL_ROWS_PER_SEGMENT);
        for (const row of group.rows) {
            const hiddenForScope = input.scope.kind === 'agent'
                ? row.visibility === 'hidden_agent' || row.visibility === 'hidden_all_agents' || row.visibility === 'hidden_current_selection'
                : row.visibility === 'hidden_all_agents';
            if (hiddenForScope && (!showHidden || sourceHidden)) continue;
            const lockedByConnectionScope = input.scope.kind === 'agent' && row.visibility === 'hidden_all_agents';
            const ref: ModelVisibilityRefV1 = agentScope
                ? {
                    scope: 'agent', agentTargetKey: agentScope.agentTargetKey,
                    providerConnectionId: connectionId, modelId: row.ref.modelId,
                }
                : { scope: 'allAgents', providerConnectionId: connectionId, modelId: row.ref.modelId };
            const presentation = presentProviderModelRow({
                modelId: row.ref.modelId,
                name: row.descriptor.name,
                description: row.descriptor.description,
                reasoningEffortLevels: reasoningEffortLevelsLabel(row.descriptor),
                // A connection's own list already names it; only the agent-wide list needs it per row,
                // and a list grouped by source says it once, in the source's header.
                contextLabel: input.scope.kind === 'agent' && !grouping ? providerModelConnectionTitle(group) : undefined,
                statusOnly: grouping !== undefined,
                // Grouped by source, a source that cannot be used says so once in its header.
                authorization: grouping ? undefined : group.authorization,
                compatibility: row.compatibility,
                endpointHealth: row.endpointHealth,
                stale: row.catalog.stale,
                loadState: row.loadState,
                confidence: row.confidence,
                visibility: lockedByConnectionScope
                    ? 'hidden_all_agents'
                    : hiddenForScope
                        ? 'hidden_agent'
                        : 'visible',
            });
            const loading = input.loadingModelKey === providerModelRowKey(group.connectionId, row.ref.modelId);
            if (collapsedSource) {
                // The picker keeps a hidden source's favorites and default; nothing else is listed here.
                const favorite = isFavorite(group.connectionId, row.ref.modelId);
                if (!favorite && !isDefault(group.connectionId, row.ref.modelId)) continue;
            }
            if (sourceHidden) {
                const favorite = isFavorite(group.connectionId, row.ref.modelId);
                groupOptions.push({
                    id: providerModelRowKey(group.connectionId, row.ref.modelId),
                    label: presentation.label,
                    ...(isDefault(group.connectionId, row.ref.modelId) ? { titleAccessory: <ModelDefaultTag /> } : {}),
                    subtitle: presentation.description,
                    accessibilityLabel: `${row.descriptor.name || row.ref.modelId}, ${group.connectionName}, ${t(favorite
                        ? 'settingsAgents.detailPage.modelsStaysVisibleFavorite'
                        : 'settingsAgents.detailPage.modelsStaysVisibleDefault')}`,
                    rightAccessoryOutsidePressable: true,
                    rightAccessory: <ModelStaysVisible favorite={favorite} />,
                });
                continue;
            }
            const option = {
                id: providerModelRowKey(group.connectionId, row.ref.modelId),
                label: presentation.label,
                ...(isDefault(group.connectionId, row.ref.modelId) ? { titleAccessory: <ModelDefaultTag /> } : {}),
                subtitle: presentation.description,
                disabled: input.readOnly === true || (lockedByConnectionScope && !input.onOpenConnection),
                accessibilityLabel: lockedByConnectionScope
                    ? `${row.descriptor.name || row.ref.modelId}, ${group.connectionName}, ${t('settingsProviders.models.hiddenForAllAgents')}`
                    : `${row.descriptor.name || row.ref.modelId}, ${group.connectionName}, ${modelVisibilityActionLabel(hiddenForScope)}`,
                rightAccessoryOutsidePressable: true,
                rightAccessory: (
                    <ModelVisibilityAccessory
                        label={`${presentation.label}, ${providerModelConnectionTitle(group)}`}
                        visible={!hiddenForScope}
                        disabled={input.readOnly === true || lockedByConnectionScope}
                        isFavorite={isFavorite(group.connectionId, row.ref.modelId)}
                        contextLabel={grouping && row.descriptor.contextWindowTokens
                            ? formatTokenCount(row.descriptor.contextWindowTokens)
                            : undefined}
                        onToggleFavorite={!input.readOnly && agentScope && grouping?.onToggleFavorite
                            ? () => grouping.onToggleFavorite?.({
                                ref: { agentTargetKey: agentScope.agentTargetKey, providerConnectionId: connectionId, modelId: row.ref.modelId },
                                modelLabel: row.descriptor.name || row.ref.modelId,
                                providerDisplaySnapshot: {
                                    providerName: group.providerName,
                                    connectionName: group.connectionName,
                                    connectionRole: group.connectionRole,
                                    connectionDisplayNameMode: group.connectionDisplayNameMode,
                                },
                            })
                            : undefined}
                        onSetDefault={!input.readOnly && agentScope && !isDefault(group.connectionId, row.ref.modelId) && grouping?.onSetDefault
                            ? () => grouping.onSetDefault?.({ agentTargetKey: agentScope.agentTargetKey, providerConnectionId: connectionId, modelId: row.ref.modelId })
                            : undefined}
                        onVisibleChange={(visible) => input.onSetVisibility(ref, !visible)}
                        onShowOnly={!input.readOnly && !lockedByConnectionScope && input.onShowOnly
                            ? () => input.onShowOnly?.(ref)
                            : undefined}
                        onLoad={!input.readOnly && !loading
                            && group.modelLoadAction === 'available'
                            && row.loadState === 'unloaded'
                            && input.onLoadModel
                            ? () => input.onLoadModel?.(group.connectionId, row.ref.modelId)
                            : undefined}
                        onCancelLoad={loading ? input.onCancelModelLoad : undefined}
                        loading={loading}
                        onRemove={!input.readOnly && row.sources.manual && input.onRemoveManualModel
                            ? () => input.onRemoveManualModel?.(group.connectionId, row.ref.modelId)
                            : undefined}
                        onEditEffort={!input.readOnly && row.sources.manual && input.onEditManualModel
                            ? () => input.onEditManualModel?.(group.connectionId, row.ref.modelId)
                            : undefined}
                        onEditGeneration={!input.readOnly && (row.sources.manual || row.sources.static) && input.onEditGenerationSettings
                            ? () => input.onEditGenerationSettings?.(group.connectionId, row.ref.modelId)
                            : undefined}
                    />
                ),
                onSelect: input.readOnly ? undefined : lockedByConnectionScope
                    ? () => input.onOpenConnection?.(group.connectionId)
                    : () => input.onSetVisibility(ref, !hiddenForScope),
            };
            const target = grouping
                ? groupOptions
                : hiddenForScope
                    ? hiddenOptions
                    : row.sources.manual
                        ? manualOptions
                        : availableOptions;
            target.push(option);
        }
        if (grouping) {
            const onOpenConnection = input.onOpenConnection;
            const sourceStatus = presentProviderSourceStatus(group);
            sourceSections.push({
                id: `source:${group.connectionId}`,
                title: providerModelConnectionTitle(group),
                description: sourceHidden
                    ? t('settingsAgents.detailPage.modelsSourceHiddenDescription', { count: group.rows.length })
                    : [
                        grouping.connectionDescription,
                        sourceStatus.experimental ? t('settingsProviders.models.experimental') : null,
                        sourceStatus.needsComputer
                            ? t('settingsAgents.detailPage.modelsNeedsComputer')
                            : sourceStatus.errorTitleKey ? t(sourceStatus.errorTitleKey) : null,
                    ].filter(Boolean).join(' · '),
                mark: grouping.renderSourceMark?.(group.connectionId),
                headerAccessory: grouping.renderSourceAccessory?.(group.connectionId),
                ...(collapsedSource && onOpenConnection ? { footerAction: {
                    label: t('settingsAgents.detailPage.modelsBrowseSource', { count: group.rows.length }),
                    onPress: () => onOpenConnection(group.connectionId),
                } } : {}),
                options: groupOptions,
                count: groupOptions.length,
                virtualization: 'auto',
            });
        }
    }
    if (grouping) {
        const sections: ProviderModelManagerSection[] = [
            {
                id: 'source:native',
                title: grouping.nativeTitle,
                description: grouping.nativeDescription,
                mark: grouping.nativeMark,
                options: nativeOptions,
                count: nativeOptions.length,
                virtualization: 'auto',
            },
            ...sourceSections,
        // A hidden source keeps its sheet even with nothing listed: its switch turns it back on.
        ];
        return sections.filter((section) => section.options.length > 0 || section.footerAction !== undefined
            || (section.id !== 'source:native' && grouping.isSourceShown?.(section.id.slice('source:'.length)) === false));
    }
    return [
        { id: 'available', title: t('settingsProviders.models.available'), options: availableOptions },
        { id: 'hidden', title: t('settingsProviders.models.hidden'), options: hiddenOptions },
        { id: 'manual', title: t('settingsProviders.models.manual'), options: manualOptions },
    ].flatMap((section): SelectionListSection[] => section.options.length > 0 ? [{
        ...section,
        count: section.options.length,
        virtualization: 'auto',
    }] : []);
}

export function ProviderModelManager(props: Readonly<{
    scope: ProviderModelManagerScope;
    nativeModels: readonly ProviderModelManagerNativeModel[];
    groups: readonly ProviderModelManagerGroup[];
    showHidden: boolean;
    readOnly?: boolean;
    onSetVisibility: (ref: ModelVisibilityRefV1, hidden: boolean) => void;
    onRemoveManualModel?: (connectionId: string, modelId: string) => void;
    onEditManualModel?: (connectionId: string, modelId: string) => void;
    /** A connection page only: opens one model's generation settings (its output allowance). */
    onEditGenerationSettings?: (connectionId: string, modelId: string) => void;
    onShowOnly?: (ref: ModelVisibilityRefV1) => void;
    onLoadModel?: (connectionId: string, modelId: string) => void;
    onCancelModelLoad?: () => void;
    onOpenConnection?: (connectionId: string) => void;
    loadingModelKey?: string | null;
    onShowAll?: () => void;
    onHideAll?: () => void;
    onResetVisibility?: () => void;
    onRequestClose: () => void;
    headerActions?: React.ReactNode;
    /**
     * Host the list as one section of a page, inside the page's single scroll, instead of as a
     * full-route list. The page still virtualizes: only the rows near the viewport mount.
     */
    page?: ProviderModelManagerPageHost;
    /** Agent lists only: one sheet per source instead of shown / hidden / added groups. */
    grouping?: ProviderModelManagerSourceGrouping;
    testID?: string;
}>): React.ReactElement {
    const scopeIdentity = props.scope.kind === 'agent'
        ? props.scope.agentTargetKey
        : props.scope.connectionId;
    const scope = React.useMemo<ProviderModelManagerScope>(() => props.scope.kind === 'agent'
        ? { kind: 'agent', agentTargetKey: scopeIdentity }
        : { kind: 'connection', connectionId: scopeIdentity }, [props.scope.kind, scopeIdentity]);
    const nativeModels = props.nativeModels.length === 0 ? EMPTY_NATIVE_MODELS : props.nativeModels;
    const groups = props.groups.length === 0 ? EMPTY_GROUPS : props.groups;
    const canRemoveManualModel = props.onRemoveManualModel !== undefined;
    const canEditManualModel = props.onEditManualModel !== undefined;
    const canEditGenerationSettings = props.onEditGenerationSettings !== undefined;
    const canShowOnly = props.onShowOnly !== undefined;
    const canLoadModel = props.onLoadModel !== undefined;
    const canCancelModelLoad = props.onCancelModelLoad !== undefined;
    const canOpenConnection = props.onOpenConnection !== undefined;
    const onSetVisibility = useEventCallback((ref: ModelVisibilityRefV1, hidden: boolean) => {
        if (!props.readOnly) props.onSetVisibility(ref, hidden);
    });
    const onRemoveManualModel = useEventCallback((connectionId: string, modelId: string) => {
        props.onRemoveManualModel?.(connectionId, modelId);
    });
    const onEditManualModel = useEventCallback((connectionId: string, modelId: string) => {
        props.onEditManualModel?.(connectionId, modelId);
    });
    const onEditGenerationSettings = useEventCallback((connectionId: string, modelId: string) => {
        props.onEditGenerationSettings?.(connectionId, modelId);
    });
    const onShowOnly = useEventCallback((ref: ModelVisibilityRefV1) => {
        props.onShowOnly?.(ref);
    });
    const onLoadModel = useEventCallback((connectionId: string, modelId: string) => {
        props.onLoadModel?.(connectionId, modelId);
    });
    const onCancelModelLoad = useEventCallback(() => {
        props.onCancelModelLoad?.();
    });
    const onOpenConnection = useEventCallback((connectionId: string) => {
        props.onOpenConnection?.(connectionId);
    });
    const sections = React.useMemo(() => buildProviderModelManagerSections({
        scope,
        nativeModels,
        groups,
        showHidden: props.showHidden,
        readOnly: props.readOnly,
        onSetVisibility,
        ...(canRemoveManualModel ? { onRemoveManualModel } : {}),
        ...(canEditManualModel ? { onEditManualModel } : {}),
        ...(canEditGenerationSettings ? { onEditGenerationSettings } : {}),
        ...(canShowOnly ? { onShowOnly } : {}),
        ...(canLoadModel ? { onLoadModel } : {}),
        ...(canCancelModelLoad ? { onCancelModelLoad } : {}),
        ...(canOpenConnection ? { onOpenConnection } : {}),
        loadingModelKey: props.loadingModelKey,
        ...(props.grouping ? { grouping: props.grouping } : {}),
    }), [
        props.grouping,
        canLoadModel,
        canCancelModelLoad,
        canOpenConnection,
        canRemoveManualModel,
        canEditManualModel,
        canEditGenerationSettings,
        canShowOnly,
        groups,
        props.loadingModelKey,
        props.showHidden,
        props.readOnly,
        nativeModels,
        onLoadModel,
        onCancelModelLoad,
        onOpenConnection,
        onRemoveManualModel,
        onEditManualModel,
        onEditGenerationSettings,
        onSetVisibility,
        onShowOnly,
        scope,
    ]);
    if (props.page) {
        return (
            <ProviderModelManagerPage
                host={props.page}
                sections={sections}
                modelCount={groups.reduce((count, group) => count + group.rows.length, nativeModels.length)}
                actions={props.headerActions}
                grouped={props.grouping !== undefined && props.scope.kind === 'agent'}
                onShowAll={props.readOnly ? undefined : props.onShowAll}
                onHideAll={props.readOnly ? undefined : props.onHideAll}
                onResetVisibility={props.readOnly ? undefined : props.onResetVisibility}
            />
        );
    }
    return <ProviderModelManagerScreen {...props} sections={sections}
        onShowAll={props.readOnly ? undefined : props.onShowAll}
        onHideAll={props.readOnly ? undefined : props.onHideAll}
        onResetVisibility={props.readOnly ? undefined : props.onResetVisibility} />;
}

function ProviderModelManagerScreen(props: Readonly<{
    sections: readonly SelectionListSection[];
    onShowAll?: () => void;
    onHideAll?: () => void;
    onResetVisibility?: () => void;
    onRequestClose: () => void;
    headerActions?: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const { sections } = props;
    const rootStep = React.useMemo(() => ({
        id: 'models',
        inputPlaceholder: t('modelPickerOverlay.searchPlaceholder'),
        emptyStateLabel: t('settingsProviders.models.empty'),
        sections: sections.map((section) => ({ kind: 'static' as const, ...section })),
    }), [sections]);
    return (
        <SelectionListScreen
            testID={props.testID ?? 'provider-model-manager'}
            rootStep={rootStep}
            inputSuffix={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <ProviderModelBulkActions
                        onShowAll={props.onShowAll}
                        onHideAll={props.onHideAll}
                        onReset={props.onResetVisibility}
                    />
                    {props.headerActions}
                </View>
            )}
            selectedOptionId={null}
            onSelect={() => {}}
            onRequestClose={props.onRequestClose}
        />
    );
}

const styles = StyleSheet.create(() => ({
    // Kept mounted so keyboard focus can reach it and the row never shifts.
    menuQuiet: {
        opacity: 0,
    },
    contextLabel: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('rowDescription'),
        fontVariant: ['tabular-nums'],
    },
    sourceAccessory: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    staysVisible: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    staysVisibleText: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('rowDescription'),
    },
}));
