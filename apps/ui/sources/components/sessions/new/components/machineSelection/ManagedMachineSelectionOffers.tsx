import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import * as React from 'react';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useManagedMachineAccountSettings } from '@/components/settings/machines/managed/useManagedMachineAccountSettings';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { MANAGED_PROVISIONER_MARK_SIZE, ManagedPresetMark } from '@/components/settings/machines/managed/useManagedProvisionerPresentation';
import { MachineProvisionerPicker, type ManagedProvisionerSelection } from '@/components/settings/machines/managed/MachineProvisionerPicker';
import { ManagedMachineConfigurationView } from '@/components/settings/machines/managed/ManagedMachineConfigurationView';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { t } from '@/text';
import { buildManagedMachineSelectionOffers, type ManagedMachineDestinationProjection, type ManagedMachineSelectionDraft, type ManagedMachineSelectionOffer } from './managedMachineSelection';

/** A Project may hand off its exact controller/config selectors; ordinary pickers supply none. */
export type ManagedMachineConfigurationContinuation = ManagedProvisionerSelection & Readonly<{
    optionsSelectors?: Readonly<Record<string, unknown>>;
}>;
type OffersProps = Readonly<{
    serverId: string;
    initialConfiguration?: ManagedMachineConfigurationContinuation;
    onOffers: (serverId: string, offers: readonly ManagedMachineSelectionOffer[], projection: ManagedMachineDestinationProjection) => void;
    onUse: (draft: ManagedMachineSelectionDraft) => void;
    /**
     * Called as the configurator opens. A popover host closes itself here: the configurator is its
     * own modal and outlives the picker that opened it (lab m-pick: the configurator stands alone).
     */
    onConfigure?: () => void;
}>;

/**
 * Opens the "New machine" configurator for a preset or a one-off. The modal owns its own lifetime:
 * it closes on use, on its own close button, or when the Account binding retires, never because the
 * picker that opened it went away, so the host can close first and the configurator then stands alone.
 */
export function useManagedMachineConfigurator(input: Readonly<{
    serverId: string;
    binding: ServerCredentialAccountScopeBinding | null;
    initialConfiguration?: ManagedMachineConfigurationContinuation;
    onUse: (draft: ManagedMachineSelectionDraft) => void;
    onConfigure?: () => void;
}>): (preset: ManagedMachinePresetV1 | null) => void {
    const { binding, serverId, initialConfiguration, onUse, onConfigure } = input;
    return React.useCallback((preset: ManagedMachinePresetV1 | null) => {
        if (!binding?.isCurrent()) return;
        onConfigure?.();
        // The opener's binding belongs to the picker and dies with it; the modal keeps its own (below),
        // for the same Account.
        Modal.show({ component: ManagedMachineSelectionConfigurationModal,
            props: { serverId, preset, initialConfiguration, accountId: binding.accountId, onUse } });
    }, [binding, serverId, initialConfiguration, onUse, onConfigure]);
}

/** Mounted only by an open creation-capable picker; Account opt-out precedes every preset read. */
export function ManagedMachineSelectionOffers(props: OffersProps) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(props.serverId);
    const account = useManagedMachineAccountSettings(binding, resolution);
    React.useEffect(() => {
        if (account.settings?.managedMachineCreationEnabled !== true) props.onOffers(props.serverId, [], {
            state: account.settings?.managedMachineCreationEnabled === false ? 'unavailable' : 'pending', rowCount: 0 });
    }, [account.settings, props.serverId, props.onOffers]);
    if (!binding?.isCurrent() || account.settings?.managedMachineCreationEnabled !== true) return null;
    return <CurrentManagedMachineSelectionOffers {...props} binding={binding} key={JSON.stringify([props.serverId, binding.accountId, binding.revision])} />;
}

function CurrentManagedMachineSelectionOffers(props: OffersProps & Readonly<{ binding: ServerCredentialAccountScopeBinding }>) {
    const { binding } = props;
    const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
    const scopeKey = JSON.stringify([props.serverId, binding?.accountId, binding?.revision]);
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey, onExecuted: () => {} });
    const presets = useMachinePresets(serverIds, approval.requestApproval);
    const state = presets.statesByServerId[props.serverId];
    const homeId = getServerProfileById(props.serverId)?.serverIdentityId;
    const machines = useMachineListForServer(props.serverId);
    const router = useRouter();
    const configure = useManagedMachineConfigurator({ serverId: props.serverId, binding,
        initialConfiguration: props.initialConfiguration, onUse: props.onUse, onConfigure: props.onConfigure });
    const offers = React.useMemo(() => homeId && binding?.isCurrent() ? buildManagedMachineSelectionOffers({
        homeId, presets: presets.presetsByServerId[props.serverId] ?? [],
        oneOffTitle: t('managedMachines.picker.oneOff'), oneOffSubtitle: t('managedMachines.picker.oneOffHelp'),
        describeController: preset => getMachineDisplayName(machines?.find(machine => machine.id === preset.controller.machineId)) ?? preset.controller.machineId,
        markFor: preset => <ManagedPresetMark serverId={props.serverId} preset={preset} size={MANAGED_PROVISIONER_MARK_SIZE.rail} />,
        onConfigure: configure,
    }) : [], [homeId, binding, presets.presetsByServerId, props.serverId, machines, configure]);
    React.useEffect(() => { props.onOffers(props.serverId, offers, {
        state: !binding?.isCurrent() || state?.loading !== false || !!state?.error ? 'pending' : 'available', rowCount: offers.length,
    }); }, [offers, binding, state?.loading, state?.error, props.serverId, props.onOffers]);
    return <>
        {approval.approvalId ? <AttentionBanner testID="managed-machine-selection-approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(buildApprovalHref(approval.approvalId!, props.serverId) as never) }} /> : null}
        {state?.error ? <SurfaceStateCard kind="error" title={t('machinePresets.loadFailed')} diagnosticCode={state.error}
            action={{ label: t('common.retry'), onPress: presets.refresh }} /> : null}
    </>;
}

function ManagedMachineSelectionConfigurationModal(props: CustomModalInjectedProps & Readonly<{
    serverId: string; preset: ManagedMachinePresetV1 | null; initialConfiguration?: ManagedMachineConfigurationContinuation;
    accountId: string;
    onUse: (draft: ManagedMachineSelectionDraft) => void;
}>) {
    // The modal holds its own Account binding (the picker that opened it may be gone): it closes once
    // the Home is bound to a different Account, and only uses a draft while the opening Account is
    // the current one. A profile refresh that rebinds the same Account leaves it open.
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const closeRef = React.useRef(props.onClose);
    closeRef.current = props.onClose;
    const otherAccount = binding !== null && binding.accountId !== props.accountId;
    React.useEffect(() => {
        if (otherAccount) closeRef.current();
    }, [otherAccount]);
    const use = (draft: ManagedMachineSelectionDraft) => {
        if (!binding?.isCurrent() || binding.accountId !== props.accountId) return;
        props.onClose();
        props.onUse(draft);
    };
    const [selected, setSelected] = React.useState<ManagedProvisionerSelection | null>(() => props.preset ? {
        serverId: props.serverId, provisioner: buildQualifiedPluginContributionKey(props.preset.recipe.provider), controller: props.preset.controller,
    } : props.initialConfiguration?.serverId === props.serverId ? props.initialConfiguration : null);
    React.useEffect(() => { props.setChrome?.({ kind: 'card', title: t('managedMachines.picker.newMachine'),
        dimensions: { size: 'lg' }, phonePresentation: 'sheet', bodyScroll: 'auto', closeButtonTestID: 'managed-selection.back' }); }, [props.setChrome]);
    return selected ? <ManagedMachineConfigurationView serverId={selected.serverId} provisioner={selected.provisioner}
        initialController={selected.controller} presetId={props.preset?.id}
        initialConnectPurpose={selected.connectPurpose}
        initialOptionsSelectors={!props.preset && selected === props.initialConfiguration ? props.initialConfiguration?.optionsSelectors : undefined}
        onUse={use} />
        : <MachineProvisionerPicker serverId={props.serverId} onSelectProvisioner={setSelected} />;
}
