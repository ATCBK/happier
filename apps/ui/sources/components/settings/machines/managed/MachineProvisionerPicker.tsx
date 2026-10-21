import * as React from 'react';
import { View } from 'react-native';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useManagedProvisioners } from './useManagedProvisioners';
import { useManagedProvisionerPresentation } from './useManagedProvisionerPresentation';
import { MachineProvisionerSections } from './MachineProvisionerSections';
import type { ManagedProvisionerCard } from './managedMachineDisplay';
import { useManagedControllerScope, type ManagedControllerScope } from './useManagedControllerScope';
import type { MachinePresetCollectionSettledResult } from './machinePresetCollectionClient';

export type ManagedProvisionerSelection = Readonly<{ serverId: string; provisioner: string; controller: ManagedControllerV1; connectPurpose?: string }>;
type MachineProvisionerPickerProps = Readonly<{
    serverId: string; presetOnly?: boolean;
    /** Where "Set up this computer" leads when no machine here can manage yet (the Add form switches its own path). */
    onSetUpThisComputer?: () => void;
    /** Local presentation handoff to the same configurator, without navigation or acquisition. */
    onSelectProvisioner?: (selection: ManagedProvisionerSelection) => void;
    /**
     * The "Managed from" scope of a page that shows its chip itself (beside the Add page's ways in). The
     * picker then reads that controller and draws no chip of its own; without it, the picker owns one.
     */
    scope?: ManagedControllerScope;
}>;

export function MachineProvisionerPicker(props: MachineProvisionerPickerProps) {
    useServerProfilesGeneration();
    const [selectedHome, setSelectedHome] = React.useState(props.serverId);
    if (!selectedHome) return <View testID="managed-picker"><ItemGroup title={t('managedMachines.receipt.joins')}>
        {listServerProfiles().map(home => <Item key={home.id} testID={`managed-picker.home:${home.id}`} title={resolveHomeDisplayLabel(home, home.id)} onPress={() => setSelectedHome(home.id)} />)}
    </ItemGroup></View>;
    const shared = { serverId: selectedHome, presetOnly: props.presetOnly, onSelectProvisioner: props.onSelectProvisioner,
        onSetUpThisComputer: props.onSetUpThisComputer };
    // A page's scope speaks only for the Home it was made for.
    return props.scope && selectedHome === props.serverId
        ? <MachineProvisionerCatalog key={selectedHome} {...shared} scope={props.scope} pageOwnsChip />
        : <MachineProvisionerOwnScopeCatalog key={selectedHome} {...shared} />;
}

function MachineProvisionerOwnScopeCatalog(props: Omit<MachineProvisionerPickerProps, 'scope'>) {
    const scope = useManagedControllerScope({ serverId: props.serverId, testIDPrefix: 'managed-picker.controller' });
    return <MachineProvisionerCatalog {...props} scope={scope} pageOwnsChip={false} />;
}

function MachineProvisionerCatalog(props: Omit<MachineProvisionerPickerProps, 'scope'> & Readonly<{ scope: ManagedControllerScope; pageOwnsChip: boolean }>) {
    useMachineReachabilityRevision();
    const handler = React.useRef<(registration: ActionApprovalRegistration) => void>(() => {});
    const onApprovalPending = React.useCallback((registration: ActionApprovalRegistration) => handler.current(registration), []);
    const [checks, setChecks] = React.useState<Readonly<Record<string, MachinePresetCollectionSettledResult<MachineProvisionerCheckResultV1>>>>({});
    const checksAccount = React.useRef<string | null>(null);
    const scope = props.scope;
    const controller = scope.controller;
    const catalog = useManagedProvisioners(props.serverId, onApprovalPending, controller);
    const approval = useActionApprovalContinuation({ serverId: props.serverId, scopeKey: JSON.stringify([props.serverId, catalog.binding?.accountId]), onExecuted: () => {} });
    handler.current = approval.requestApproval;
    const router = useRouter();
    const [error, setError] = React.useState<string | null>(null);
    const compact = useViewportClass() === 'compact';
    const presentation = useManagedProvisionerPresentation({ serverId: props.serverId, controller });
    const { localized, markFor } = presentation;
    const repairAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => repairAbort.current?.abort(), [catalog.binding, controller]);
    React.useEffect(() => {
        const binding = catalog.binding;
        if (!binding || !catalog.homeId || !catalog.client || !controller) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        // The last answers stay while this read runs, even across a refreshed binding of the same Account;
        // a settled read replaces them, and another Account never sees them.
        if (checksAccount.current !== binding.accountId) { checksAccount.current = binding.accountId; setChecks({}); }
        // Each provisioner settles on its own: a slow or failed check never holds back the others' answers.
        const current = () => !abort.signal.aborted && binding.isCurrent();
        void Promise.all(catalog.provisioners.map(async provisioner => {
            const id = buildQualifiedPluginContributionKey(provisioner.contribution);
            const result = await catalog.client!.read('machines.provisioners.check', { homeId: catalog.homeId!, controller, contribution: provisioner.contribution }, { signal: abort.signal, onApprovalPending });
            if (current()) setChecks(previous => ({ ...previous, [id]: result }));
        })).then(() => { if (current()) setError(null); })
            .catch(() => { if (current()) setError('unavailable'); });
        return () => { abort.abort(); retirement.dispose(); };
    }, [catalog.binding, catalog.homeId, catalog.client, catalog.provisioners, controller, onApprovalPending]);
    const open = (contribution: string, connectPurpose?: string) => {
        if (catalog.error || !catalog.binding?.isCurrent()) return;
        if (props.onSelectProvisioner) {
            if (controller && catalog.binding?.isCurrent()) props.onSelectProvisioner({ serverId: props.serverId, provisioner: contribution, controller,
                ...(connectPurpose ? { connectPurpose } : {}) });
            return;
        }
        const params = new URLSearchParams({ serverId: props.serverId });
        if (connectPurpose) params.set('connectPurpose', connectPurpose);
        if (props.presetOnly) params.set('presetOnly', 'true');
        if (controller) { params.set('machineId', controller.machineId); params.set('installationId', controller.installationId); }
        router.push(`/settings/machines/add/${encodeURIComponent(contribution)}?${params.toString()}` as never);
    };
    const cards: ManagedProvisionerCard[] = catalog.provisioners.flatMap(provisioner => {
        const location = provisioner.descriptor.billing.location;
        const id = buildQualifiedPluginContributionKey(provisioner.contribution);
        const outcome = checks[id];
        const check = outcome?.kind === 'succeeded' ? outcome.value : undefined;
        const repairAction = check?.prerequisites?.find(prerequisite => prerequisite.status !== 'available' && prerequisite.repairAction)?.repairAction;
        const missingExecutable = check?.prerequisites?.some(prerequisite => prerequisite.status !== 'available');
        const noAccount = check?.code === 'credential_unavailable' || outcome?.kind === 'failed' && outcome.code === 'credential_unavailable';
        // A check that failed or never ran says nothing about this provisioner: it stays neutral and the catalog's one line owns the cause.
        const unreadable = outcome?.kind === 'failed' && !noAccount;
        const statusLabel = check?.status ? localized(provisioner.contribution.pluginId, check.status)
            : noAccount ? t('managedMachines.add.status.noAccount')
            : check ? t(check.available ? 'managedMachines.add.status.ready'
                : missingExecutable ? 'managedMachines.add.status.notInstalled' : 'managedMachines.add.status.needsSetup')
                : unreadable ? '' : t('managedMachines.add.status.checking');
        const title = localized(provisioner.contribution.pluginId, provisioner.descriptor.title);
        const kind = provisioner.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : undefined;
        // Two provisioners of one product ("Cua") are told apart by what each creates, from their own declarations.
        const sharesTitle = catalog.provisioners.some(other => other !== provisioner
            && localized(other.contribution.pluginId, other.descriptor.title) === title);
        // A kind reads inside a title ("Cua sandbox"); shown on its own, as a badge or row subtitle, it starts a label.
        return [{ id, title: sharesTitle && kind ? `${title} ${kind}` : title,
            kind: kind ? kind.charAt(0).toLocaleUpperCase() + kind.slice(1) : undefined,
            description: provisioner.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : '',
            location: location === 'local' ? 'local' : 'cloud', mark: (size: number) => markFor(provisioner, size),
            status: { tone: check ? check.available && location !== 'unknown' ? 'ready' : 'attention' : noAccount ? 'attention' : 'none',
                label: [statusLabel, location === 'unknown' ? t('managedMachines.add.status.billingUnknown') : null].filter(Boolean).join(' · ') },
            action: repairAction ? { kind: 'repair', label: t(noAccount ? 'managedMachines.add.action.connect'
                : missingExecutable ? 'managedMachines.add.action.getApp' : 'managedMachines.add.action.setUp'), onPress: () => {
                const binding = catalog.binding;
                if (!binding?.isCurrent()) return;
                repairAbort.current?.abort();
                const abort = new AbortController(); repairAbort.current = abort;
                void presentation.repair(repairAction, binding, abort.signal).then(outcome => {
                    if (abort.signal.aborted || !binding.isCurrent()) return;
                    if (outcome.ok) catalog.refresh(); else setError(outcome.reason);
                }).catch(() => { if (!abort.signal.aborted && binding.isCurrent()) setError('unavailable'); });
            } } : { kind: 'choose', label: t(noAccount ? 'managedMachines.add.action.connect' : 'managedMachines.add.action.choose'),
                onPress: () => open(id, noAccount ? provisioner.credentialPurposes?.[0]?.purpose.purpose : undefined),
                // Retained checks describe the card; the current controller catalog admits the handoff.
                ...(catalog.error || !catalog.binding?.isCurrent() || unreadable ? { disabled: true } : {}) } }];
    });
    const controllerName = scope.machine ? getMachineSentenceName(scope.machine) : '';
    const observedMachines = React.useMemo(() => scope.machine ? [scope.machine] : [], [scope.machine]);
    const presenceNowMs = useMachinePresenceNowMs(observedMachines);
    const controllerOnline = scope.machine ? resolveMachinePickerPresence(scope.machine, presenceNowMs,
        catalog.binding?.isCurrent() ? catalog.binding.scope : null).status === 'online' : false;
    const checkFailed = Object.values(checks).some(result => result.kind === 'failed' && result.code !== 'credential_unavailable');
    const failure = catalog.error ?? error ?? (checkFailed ? 'unavailable' : null);
    // The controller's own state, said once under the chip that changes it.
    // A catalog that answered speaks for itself; presence only explains an empty or failed one.
    const scopeState = !controller ? null
        : (failure || cards.length === 0) && !controllerOnline ? <SurfaceStateCard testID="managed-picker.offline" kind="unavailable" size="line"
            title={t('managedMachines.add.controllerOffline', { controller: controllerName })} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : failure ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error" size="line" diagnosticCode={failure}
            title={t('managedMachines.add.controllerUnreadable', { controller: controllerName })} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
        : catalog.loading && cards.length === 0 ? <SurfaceStateCard kind="loading" size="line" title={t('managedMachines.providers.loading')} />
        : !catalog.loading && cards.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('managedMachines.providers.empty')} />
        : null;
    const localResources = Object.values(checks).flatMap(result => result.kind === 'succeeded' && result.value.localResources
        ? [result.value.localResources] : [])[0];
    const localDescription = !compact && localResources?.availableCpuCores !== undefined && localResources.availableMemoryBytes !== undefined
        && localResources.availableDiskBytes !== undefined
        ? t('managedMachines.add.localDescription', { computer: controllerName, cores: String(localResources.availableCpuCores),
            memory: formatHappierDataBytes(localResources.availableMemoryBytes, { kind: 'memory' }), disk: formatHappierDataBytes(localResources.availableDiskBytes, { kind: 'storage' }) })
        : t('managedMachines.add.localDescriptionShort', { computer: controllerName });
    // A page sets the chip on its first section's header; a grouped surface (the composer's modal) has no
    // section header actions, so the same chip leads the picker as its own "Managed from" row.
    // On a phone the chip is wider than a header action may be, so it also leads as its own row there.
    const pageSections = useListPresentation() === 'page' && !compact;
    const chip = props.pageOwnsChip ? null : scope.chip;
    const scopeRow = !pageSections && chip ? <ItemGroup>
        {/* The chip is wider than a short value beside a label, so it sits beneath "Managed from". */}
        <Item testID="managed-picker.scope" title={t('managedMachines.config.managedFrom')} mode="info" showChevron={false} rightElement={chip}
            accessoryLayout="stacked" />
    </ItemGroup> : null;
    const retryMachineList = () => { void getSyncSingleton().refreshMachines({ serverId: props.serverId }).catch(() => {}); };
    const setUpThisComputer = props.onSetUpThisComputer ?? (() => router.push('/settings/machines/add?path=thisComputer' as never));
    return <View testID="managed-picker">
        {approval.approvalId ? <AttentionBanner testID="managed-picker.approval" title={t('approvals.title')} description={t('approvals.status.open')}
            action={{ label: t('approvals.details'), onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(props.serverId)}` as never) }} /> : null}
        {!scope.hasCandidates && catalog.error ? <SurfaceStateCard testID="managed-picker.unavailable" kind="error"
            title={t('managedMachines.providers.unavailable')} diagnosticCode={catalog.error} action={{ label: t('common.retry'), onPress: catalog.refresh }} />
            : !scope.hasCandidates && scope.machineList === 'loading' ? <SurfaceStateCard testID="managed-picker.machines-loading" kind="loading" size="line"
            title={t('managedMachines.providers.loading')} />
            : !scope.hasCandidates && scope.machineList === 'unavailable' ? <SurfaceStateCard testID="managed-picker.machines-unavailable" kind="error"
            title={t('managedMachines.providers.unavailable')} action={{ label: t('common.retry'), onPress: retryMachineList }} />
            : !scope.hasCandidates ? <SurfaceStateCard testID="managed-picker.no-controller" kind="empty"
            title={t('managedMachines.add.noControllerTitle')} reason={t('managedMachines.add.noControllerReason')}
            action={{ label: t('managedMachines.add.setUpThisComputer'), onPress: setUpThisComputer }} />
            : cards.length > 0 ? <>
                {scopeRow}
                {/* The line is page content like the sections beneath it: an edge-only section gives it the page column. */}
                {scopeState ? <ItemGroup surface="none">{scopeState}</ItemGroup> : null}
                <MachineProvisionerSections cards={cards} compact={compact} testID="managed-picker.provisioners" scope={pageSections && chip ? chip : undefined}
                    localTitle={t('managedMachines.add.onThisComputer')} localDescription={localDescription} />
            </> : pageSections ? <ItemGroup title={chip ? t('managedMachines.config.managedFrom') : undefined} action={chip ?? undefined} surface="none">{scopeState}</ItemGroup>
            : <>{scopeRow}{scopeState}</>}
    </View>;
}
