import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import type { RoleEngineV1 } from '@happier-dev/protocol';
import { PROVIDER_REASONING_EFFORT_OPTION_ID } from '@happier-dev/protocol/providers/catalog/reasoningEffort';

import { resolveRoleEngineTargetKey, useRoleEngineCatalog } from '@/components/roles/catalog/useRoleEnginePresentation';
import { AgentInputChipPickerPopover } from '@/components/sessions/agentInput/components/AgentInputChipPickerPopover';
import { buildSessionAgentPickerDetailContent } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import { buildSessionAgentPickerOptions } from '@/components/sessions/agentPicker/buildSessionAgentPickerOptions';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useActiveServerAccountScope, useAuthoringMemoryField, useSettings } from '@/sync/domains/state/storage';
import { useAllMachines } from '@/sync/store/hooks';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { resolveDefaultDirectoryForMachine } from '@/utils/sessions/machineDefaultDirectory';
import { t } from '@/text';
import { buildRolesRailPickerOption, type RolesRailPickerOptionParams } from '../rail/buildRolesRailPickerOption';
import { AgentInputSelectionPopover } from '@/components/sessions/agentInput/selection/AgentInputSelectionPopover';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

/** The Agent config option a role's `engine.effort` is (the same id `admitAgentStartV1` stamps). */
const ROLE_EFFORT_CONFIG_OPTION_ID = PROVIDER_REASONING_EFFORT_OPTION_ID;

/**
 * A role's engine as a page field: the value ("Claude · opus-5.5") in the field box, opening the same
 * engine popover the composer uses (Agents in the rail, the chosen Agent's models beside it).
 * Nothing is asked of a machine until the popover opens on an Agent.
 */
export const RoleEngineField = React.memo(function RoleEngineField(props: Readonly<{
    serverId?: string | null;
    /** A launch edits its own Machine's native options; neutral Account settings use the incumbent preferences. */
    machineId?: string | null;
    directory?: string | null;
    engine: RoleEngineV1 | undefined;
    label: string | null;
    /** Assistive tech's full name for the engine, when `label` leaves out what the leading mark says (the agent). */
    accessibleLabel?: string | null;
    leading?: React.ReactNode;
    /** The agent a role without an engine follows is not known yet: the field shows a quiet bar, no words. */
    pending?: boolean;
    /** `chip`: a soft borderless pill among a row's quiet facts (a Work row); `field` (default): a configuration page's bordered field. */
    presentation?: 'field' | 'chip';
    disabled?: boolean;
    onChange: (engine: RoleEngineV1) => void;
    /** Engine-group consumers may also choose a Role through the incumbent rail. */
    roleSelection?: RolesRailPickerOptionParams;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const scope = useActiveServerAccountScope(props.serverId);
    const unavailable = props.serverId !== undefined && scope === null;
    const anchorRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const trigger = renderDropdownItemTriggerRightElement({
        detail: props.label ?? t('roles.rail.defaultEngine'),
        open,
        detailColor: theme.colors.text.primary,
        chevronColor: theme.colors.text.secondary,
        field: resolveFieldBoxColors(theme, 'idle', props.presentation === 'chip' ? 'document' : 'field'),
        ...(props.presentation === 'chip' ? { fieldDensity: 'chip' as const } : {}),
        placeholder: t('roles.rail.defaultEngine'),
        leading: props.pending ? undefined : props.leading,
        loading: props.pending === true,
    });
    return (
        <View ref={anchorRef} collapsable={false}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={props.pending ? t('roles.settings.engineTitle') : `${t('roles.settings.engineTitle')}: ${props.accessibleLabel ?? props.label ?? t('roles.rail.defaultEngine')}`}
                disabled={props.disabled || unavailable}
                // The chip is drawn compact; its press box keeps the platform's target size.
                {...(props.presentation === 'chip' ? { style: { minHeight: resolveMinimumInteractiveTargetSize(Platform.OS), justifyContent: 'center' as const } } : {})}
                onPress={() => { if (!unavailable) setOpen(true); }}
            >
                {trigger}
            </HappierPressable>
            {open && !unavailable ? (
                <RoleEnginePopover
                    capabilityServerId={scope?.serverId ?? ''}
                    machineId={props.machineId}
                    directory={props.directory}
                    anchorRef={anchorRef}
                    engine={props.engine}
                    onChange={props.onChange}
                    roleSelection={props.roleSelection}
                    onRequestClose={() => setOpen(false)}
                />
            ) : null}
        </View>
    );
});

/** Mounted only while open: the Agent catalog and model probes belong to the open popover. */
function RoleEnginePopover(props: Readonly<{
    capabilityServerId: string;
    machineId?: string | null;
    directory?: string | null;
    anchorRef: React.RefObject<View | null>;
    engine: RoleEngineV1 | undefined;
    onChange: (engine: RoleEngineV1) => void;
    roleSelection?: RolesRailPickerOptionParams;
    onRequestClose: () => void;
}>) {
    const settings = useSettings();
    const { entries, ready, scope, snapshot } = useRoleEngineCatalog(props.capabilityServerId || undefined);
    const machines = useAllMachines();
    const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
    const reachabilityRevision = useMachineReachabilityRevision();
    const selectedMachineId = React.useMemo(() => props.machineId !== undefined ? props.machineId : resolvePreferredMachineId({
        machines, scope, recentMachinePaths, onlineOnly: true,
    }), [props.machineId, machines, scope, recentMachinePaths, reachabilityRevision]);
    const cwd = React.useMemo(() => props.directory !== undefined ? props.directory : resolveDefaultDirectoryForMachine({
        machineId: selectedMachineId, machines,
        recentPaths: recentMachinePaths.filter(entry => entry.machineId === selectedMachineId).map(entry => entry.path),
    }) || null, [props.directory, selectedMachineId, machines, recentMachinePaths]);
    const { capabilityServerId } = props;
    const { engine, onChange } = props;
    const engineTargetKey = engine ? resolveRoleEngineTargetKey(engine.agentTargetKey) : null;
    const options = React.useMemo(() => buildSessionAgentPickerOptions({
        entries,
        leadingOptions: props.roleSelection ? [buildRolesRailPickerOption(props.roleSelection)] : undefined,
        identityScope: { machineId: null, serverId: capabilityServerId || null, current: false },
        resolvePresentation: () => ({ disabled: false, muted: false }),
        resolveBehavior: ({ entry }) => ({
            detailTitle: entry.title,
            deferRenderDetailContent: true,
            deferredDetailContentCacheKey: `role-engine:${entry.backendTargetKey}`,
            closeOnSelectImmediate: false,
            onSelectImmediate: () => {
                if (engineTargetKey !== entry.backendTargetKey) {
                    onChange({ agentTargetKey: entry.backendTargetKey });
                }
            },
            renderDetailContent: () => buildSessionAgentPickerDetailContent({
                backendTarget: entry.backendTarget,
                agentCatalogEntry: entry.agentCatalogEntry,
                runtimeCarrierAgentId: entry.agentId,
                selectedMachineId,
                capabilityServerId,
                cwd,
                settings,
                selection: {
                    modelId: engine && engineTargetKey === entry.backendTargetKey ? engine.modelId ?? '' : '',
                    sessionModeId: null,
                    // The role's effort is the Agent's `reasoning_effort` option, the one the picker
                    // offers beside the models; admission stamps it back the same way (`admitAgentStartV1`).
                    configOverrides: engine?.effort && engineTargetKey === entry.backendTargetKey
                        ? { [ROLE_EFFORT_CONFIG_OPTION_ID]: engine.effort } : {},
                },
                onSelectionChange: (next) => {
                    const effort = next.configOverrides[ROLE_EFFORT_CONFIG_OPTION_ID];
                    onChange({
                        agentTargetKey: entry.backendTargetKey,
                        ...(next.modelId ? { modelId: next.modelId } : {}),
                        ...(effort ? { effort } : {}),
                    });
                },
            }),
        }),
    }), [capabilityServerId, cwd, selectedMachineId, engine, engineTargetKey, entries, onChange, props.roleSelection, settings]);

    if (!ready) {
        const unavailable = scope === null || snapshot?.catalog.status === 'unavailable' || snapshot?.catalog.status === 'partial';
        return <AgentInputSelectionPopover open anchorRef={props.anchorRef} onRequestClose={props.onRequestClose}>
            {() => <SurfaceStateCard testID="role-engine-catalog-state" size="line" kind={unavailable ? 'error' : 'loading'}
                title={t(unavailable ? 'common.unavailable' : 'common.loading')} />}
        </AgentInputSelectionPopover>;
    }
    return (
        <AgentInputChipPickerPopover
            open
            anchorRef={props.anchorRef}
            title=""
            options={options}
            selectedOptionId={engineTargetKey}
            onSelect={() => {}}
            onRequestClose={props.onRequestClose}
            detailContentOwnsScroll
            maxHeightCap={460}
        />
    );
}
