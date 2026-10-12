import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { PluginExecutionOriginActionOutputSchemas } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { accountSettingsScopeKeySuffix, areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { resolveMachineAdministrationTargetLabel, type MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import {
    getPluginExecutionOriginCandidateOrigin,
    getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginExecutionOriginCandidateV1,
    type PluginMachineOriginRejectionReasonV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import {
    type PluginExecutionOriginSelectionMutationResult,
    type PluginMachineExecutionOriginSelectionV1,
    type PluginExecutionOriginPreferenceApproval,
} from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

type PreferenceActionSettlement = ReturnType<typeof PluginExecutionOriginActionOutputSchemas['plugins.execution_origin.set']['parse']>;
const EMPTY_MACHINE_CANDIDATES: readonly MachineAdministrationCandidateV1[] = Object.freeze([]);

/** Mount Artifact result custody only for an intent actually awaiting review. */
function PluginOriginApprovalNotice(props: Readonly<{
    pending: PluginExecutionOriginPreferenceApproval;
    presentation: 'row' | 'inline';
    testID?: string;
    onFinished: (result: PreferenceActionSettlement | null) => void;
    onScopeChanged: () => void;
}>) {
    const router = useRouter();
    const currentScope = useAccountSettingsScope();
    const pending = props.pending;
    const approval = useActionApprovalContinuation({
        scopeKey: accountSettingsScopeKeySuffix(pending.scope), serverId: pending.scope.serverId,
        // The settings mutation already publishes its canonical store projection.
        onExecuted: () => {},
    });
    React.useEffect(() => {
        if (currentScope && !areAccountSettingsScopesEqual(currentScope, pending.scope)) props.onScopeChanged();
    }, [currentScope, pending.scope, props.onScopeChanged]);
    React.useEffect(() => {
        approval.requestApproval(createActionApprovalContinuation({
            artifactId: pending.approval.artifactId, actionId: pending.approval.actionId,
            scope: pending.scope, expectedInput: pending.input, refreshAfterExecution: false,
            onSucceeded: (result: PreferenceActionSettlement) => props.onFinished(result),
            onFailed: () => props.onFinished(null),
        }));
    }, [approval.requestApproval, pending, props.onFinished]);
    const href = `/inbox/approvals/${encodeURIComponent(pending.approval.artifactId)}?serverId=${encodeURIComponent(pending.scope.serverId)}`;
    return <ActionApprovalPendingNotice testID={props.testID} presentation={props.presentation}
        message={t('approvals.waitingForYou')} summary={approval.approvalSummary}
        onOpenApproval={() => router.pushRetainingCurrent(href)} />;
}

type PresentedPluginOrigin = ServerScopedMachinePresentation & Readonly<{
    candidate: PluginExecutionOriginCandidateV1;
    origin: PluginMachineExecutionOriginV1;
}>;

function exactOriginKey(origin: PluginMachineExecutionOriginV1): string {
    return JSON.stringify(origin);
}

function exactOriginsEqual(
    left: PluginMachineExecutionOriginV1 | null,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return left !== null && arePluginMachineExecutionOriginsEqual(left, right);
}

/**
 * Suppress a duplicate offline reason only when the real Machine row already states it.
 * A source without a Machine record must retain its own obstruction.
 */
function resolvePickerRowDetail(machine: PresentedPluginOrigin): string {
    const candidate = machine.candidate;
    const reason = candidate.validation.kind === 'rejected' ? candidate.validation.reason : null;
    if (machine.presence !== null && !isMachineOnline(machine)
        && candidate.releaseContent !== 'conflict' && (reason === 'offline' || reason === 'stale')) {
        return `${t('common.version')} ${getPluginExecutionOriginCandidateVersion(candidate)}`;
    }
    return resolveCandidatePresentationDetail(candidate);
}

function resolveCandidatePresentationDetail(candidate: PluginExecutionOriginCandidateV1): string {
    const version = `${t('common.version')} ${getPluginExecutionOriginCandidateVersion(candidate)}`;
    if (candidate.releaseContent === 'conflict') {
        return `${t('settingsPlugins.executionOriginReleaseContentConflict')} · ${version}`;
    }
    return isPluginMachineExecutionOriginCandidateSelectable(candidate)
        ? version
        : `${originReasonDetail(candidate.validation.kind === 'rejected' ? candidate.validation.reason : 'unknown')} · ${version}`;
}

function originReasonDetail(reason: PluginMachineOriginRejectionReasonV1 | 'no_materialization' | 'different_versions'): string {
    switch (reason) {
        case 'content_conflict': return t('settingsPlugins.executionOriginReleaseContentConflict');
        case 'disabled': return t('settingsPlugins.machineMatrix.state.disabled');
        case 'untrusted': return t('settingsPlugins.machineMatrix.state.untrusted');
        case 'incompatible': return t('settingsPlugins.machineMatrix.state.incompatible');
        case 'machine_local': return t('settingsPlugins.machineMatrix.state.localOnly');
        case 'offline': return t('settingsProviders.detail.machineOffline');
        case 'stale': return t('settingsPlugins.machineMatrix.state.staleOffline');
        case 'missing': return t('settingsPlugins.targetSelection.missing');
        case 'replaced': return t('settingsPlugins.targetSelection.replaced');
        case 'revoked': return t('settingsPlugins.targetSelection.revoked');
        case 'plugin_mismatch': return t('settingsPlugins.targetSelection.pluginMismatch');
        case 'no_materialization': return t('settingsPlugins.targetSelection.noMaterialization');
        case 'different_versions': return t('settingsPlugins.targetSelection.differentVersions');
        case 'unknown': return t('settingsPlugins.targetSelection.unknown');
    }
}

function buildOriginGroups(
    candidates: readonly PluginExecutionOriginCandidateV1[],
    machineCandidates: readonly MachineAdministrationCandidateV1[],
    machineRecords: readonly (Machine | null)[],
): readonly ServerScopedMachineGroup<PresentedPluginOrigin>[] {
    const groups = new Map<string, PresentedPluginOrigin[]>();
    for (const [index, candidate] of candidates.entries()) {
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        const ref = getPluginMachineExecutionOriginRef(origin);
        const labels = resolveMachineAdministrationTargetLabel({ target: { serverIdentityId: origin.serverIdentityId, machineId: ref.machineId }, candidates: machineCandidates })!;
        const machine = machineRecords[index];
        const rows = groups.get(origin.serverIdentityId) ?? [];
        rows.push(Object.freeze({
            ...(machine ? buildMachineDisplayRenderableFromMachine(machine) : {
                // Required row-shape defaults carry no presence authority without a Machine record.
                presence: null,
                updatedAt: 0,
                active: false,
                activeAt: 0,
                metadataVersion: 0,
            }),
            id: ref.machineId,
            serverId: origin.serverIdentityId,
            serverName: labels.server,
            // The machine id is not a host: naming it one would print the opaque id as the row's
            // subtitle and as the hint that tells same-named machines apart.
            metadata: Object.freeze({ displayName: labels.machine }),
            candidate,
            origin,
        }));
        groups.set(origin.serverIdentityId, rows);
    }
    return Object.freeze([...groups.entries()].map(([serverIdentityId, machines]) => Object.freeze({
        serverId: serverIdentityId,
        serverName: machines[0]!.serverName,
        machines,
        loading: false,
        signedOut: false,
    })));
}

/** Join presence only while the shared picker is mounted, using its exact Home/Machine identity. */
function PluginOriginPickerGroups(props: Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    machineCandidates: readonly MachineAdministrationCandidateV1[];
    children: (groups: readonly ServerScopedMachineGroup<PresentedPluginOrigin>[]) => React.ReactNode;
}>) {
    const machineInputs = getStorage()(useShallow((state) => props.candidates.flatMap((candidate) => {
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        const machine = resolveServerScopedMachine(state, origin.serverIdentityId, getPluginMachineExecutionOriginRef(origin).machineId);
        // The store can retain a record's identity while its heartbeat restores presence.
        // Capture the primitive too so that restoration invalidates this open projection.
        return [machine, machine?.activeAt];
    })));
    const machines = React.useMemo(() => machineInputs.filter((input): input is Machine | null => input === null || typeof input === 'object'),
        [machineInputs]);
    const knownMachines = React.useMemo(() => machines.filter((machine): machine is Machine => machine !== null), [machines]);
    // Heartbeats mutate retained records in place. The canonical deadline clock re-reads those
    // records before any grace expiry; plugin provenance never becomes a liveness clock.
    const nowMs = useMachinePresenceNowMs(knownMachines);
    const groups = React.useMemo(() => buildOriginGroups(props.candidates, props.machineCandidates, machines),
        [props.candidates, props.machineCandidates, machines, nowMs]);
    return <>{props.children(groups)}</>;
}

export type PluginMachineExecutionOriginPresentation = Readonly<{
    title: string;
    subtitle?: string;
    detail: string;
    selected: boolean;
}>;

/** The one user-facing presentation for the exact persisted plugin origin. */
export function resolvePluginMachineExecutionOriginPresentation(
    selection: PluginMachineExecutionOriginSelectionV1,
    machineCandidates: readonly MachineAdministrationCandidateV1[] = [],
): PluginMachineExecutionOriginPresentation {
    const selectedOrigin = selection.selectedOrigin
        ?? (selection.state.kind === 'selected' ? selection.state.origin : null);
    if (selectedOrigin) {
        const selectedRef = getPluginMachineExecutionOriginRef(selectedOrigin);
        const labels = resolveMachineAdministrationTargetLabel({ target: { serverIdentityId: selectedOrigin.serverIdentityId, machineId: selectedRef.machineId }, candidates: machineCandidates })!;
        const selectedCandidate = selection.candidates.find((candidate) => exactOriginsEqual(
            selectedOrigin,
            getPluginExecutionOriginCandidateOrigin(candidate),
        ));
        return {
            title: labels.machine,
            subtitle: labels.machine === selectedRef.machineId
                ? labels.server
                : [labels.server, selectedRef.machineId].join(' · '),
            detail: selection.state.kind === 'unavailable'
                ? selection.state.reasons.map(originReasonDetail).join(' · ')
                : selectedCandidate
                ? resolveCandidatePresentationDetail(selectedCandidate)
                : t('common.unavailable'),
            selected: true,
        };
    }
    if (selection.state.kind === 'conflict') {
        return {
            title: t('common.warning'),
            detail: selection.state.reasons.map(originReasonDetail).join(' · '),
            selected: false,
        };
    }
    // Nothing chosen: say so, and whether there is anything to choose from (never the New Session copy).
    return {
        title: selection.state.kind === 'unavailable'
            ? t('settingsPlugins.surfaces.runOnNoneAvailable')
            : t('settingsPlugins.surfaces.runOnNoneChosen'),
        detail: selection.state.kind === 'unavailable'
            ? selection.state.reasons.map(originReasonDetail).join(' · ')
            : t('settingsPlugins.targetSelection.selectionRequired'),
        selected: false,
    };
}

export function PluginMachineExecutionOriginSelectorView(props: Readonly<{
    selection: PluginMachineExecutionOriginSelectionV1;
    testIDPrefix?: string;
    /** Contextual label for the machine scope this selector presents. */
    groupTitle?: string;
    presentation?: 'section' | 'chip';
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
}>) {
    const { theme } = useUnistyles();
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [settlementError, setSettlementError] = React.useState<string | null>(null);
    const [pendingApproval, setPendingApproval] = React.useState<PluginExecutionOriginPreferenceApproval | null>(null);
    const settleSelection = React.useCallback(async (
        mutation: Promise<PluginExecutionOriginSelectionMutationResult>,
    ) => {
        try {
            const result = await mutation;
            if (result.status === 'approvalPending') {
                setPendingApproval(result);
                setSettlementError(null);
                setPickerOpen(false);
                return true;
            }
            if (result.status === 'applied') {
                setSettlementError(null);
                setPickerOpen(false);
                return true;
            }
            setSettlementError(result.status === 'outcomeUnknown'
                ? t('settingsProviders.errors.mutationOutcomeUnknownDescription')
                : t('settingsPlugins.genericSettingsSaveError'));
        } catch {
            setSettlementError(t('settingsPlugins.genericSettingsSaveError'));
        }
        return false;
    }, []);
    const dismissApproval = React.useCallback(() => setPendingApproval(null), []);
    const finishApproval = React.useCallback((result: PreferenceActionSettlement | null) => {
        setPendingApproval(null);
        if (!result) {
            setSettlementError(t('settingsPlugins.genericSettingsSaveError'));
            return;
        }
        void settleSelection(Promise.resolve(result.status === 'applied' ? { ...result, value: undefined } : result));
    }, [settleSelection]);
    const machineCandidates = props.machineCandidates ?? props.selection.machineCandidates ?? EMPTY_MACHINE_CANDIDATES;
    const current = resolvePluginMachineExecutionOriginPresentation(props.selection, machineCandidates);
    const hasCandidates = props.selection.candidates.length > 0;
    const selectedOrigin = props.selection.selectedOrigin
        ?? (props.selection.state.kind === 'selected' ? props.selection.state.origin : null);
    const currentTestID = props.testIDPrefix ? `${props.testIDPrefix}.current` : undefined;
    const clearTestID = props.testIDPrefix ? `${props.testIDPrefix}.clear` : undefined;
    const groupTitle = props.groupTitle ?? t('settingsProviders.detail.targetMachine');
    const clearAccessibilityScope = props.groupTitle ?? t('settingsPlugins.executionOriginTitle');

    if (props.presentation === 'chip') {
        return <><SelectionListFilterChip filter={{
            id: 'plugin-execution',
            label: groupTitle,
            valueLabel: current.title,
            icon: <Icon name="desktop" size={14} color={theme.colors.text.secondary} />,
            muted: !current.selected,
            testID: props.testIDPrefix ? `${props.testIDPrefix}.chip` : undefined,
            ...(hasCandidates ? {
                renderPopoverContent: ({ close, maxHeight }) => (
                    <>
                    <PluginOriginPickerGroups candidates={props.selection.candidates} machineCandidates={machineCandidates}>
                    {(groups) => <NewSessionMachineSelectionContent<PresentedPluginOrigin>
                        groups={groups}
                        selectedMachine={groups.flatMap((group) => group.machines).find((machine) => exactOriginsEqual(selectedOrigin, machine.origin)) ?? null}
                        selectedServerId={selectedOrigin?.serverIdentityId ?? null}
                        recentMachines={[]}
                        favoriteMachines={[]}
                        onSelectMachine={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)).then((applied) => { if (applied) close(); }); }}
                        onSelectScopedMachine={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)).then((applied) => { if (applied) close(); }); }}
                        resolveMachineAvailability={(machine) => ({
                            detail: resolvePickerRowDetail(machine),
                            selectable: isPluginMachineExecutionOriginCandidateSelectable(machine.candidate),
                        })}
                        showFavorites={false}
                        showRecent={false}
                        showSearch={false}
                        showCliGlyphs={false}
                        autoDetectCliGlyphs={false}
                        testIdPrefix={props.testIDPrefix ? `${props.testIDPrefix}.picker` : undefined}
                        testID={props.testIDPrefix ? `${props.testIDPrefix}.picker-list` : undefined}
                        maxHeight={maxHeight}
                    />}
                    </PluginOriginPickerGroups>
                    {props.selection.selectedOrigin ? <Item
                        testID={clearTestID}
                        title={t('settingsPlugins.targetSelection.clear')}
                        accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${clearAccessibilityScope}`}
                        onPress={() => { void settleSelection(props.selection.clearOrigin()).then((applied) => { if (applied) close(); }); }}
                        showChevron={false}
                    /> : null}
                    {settlementError ? <Item title={settlementError} mode="info" showChevron={false} /> : null}
                    </>
                ),
            } : {}),
        }} />{pendingApproval ? <PluginOriginApprovalNotice key={pendingApproval.approval.artifactId} pending={pendingApproval} presentation="inline"
            testID={props.testIDPrefix ? `${props.testIDPrefix}.approvalPending` : undefined}
            onFinished={finishApproval} onScopeChanged={dismissApproval} /> : null}</>;
    }

    return (
        <>
            <ItemGroup title={groupTitle}>
                {pendingApproval ? <PluginOriginApprovalNotice key={pendingApproval.approval.artifactId} pending={pendingApproval} presentation="row"
                    testID={props.testIDPrefix ? `${props.testIDPrefix}.approvalPending` : undefined}
                    onFinished={finishApproval} onScopeChanged={dismissApproval} /> : null}
                <Item
                    testID={currentTestID}
                    title={current.title}
                    subtitle={[current.subtitle, current.detail].filter(Boolean).join('\n')}
                    subtitleLines={0}
                    detail={hasCandidates ? t('common.change') : undefined}
                    selected={current.selected}
                    mode={hasCandidates ? 'interactive' : 'info'}
                    showChevron={hasCandidates}
                    accessibilityExpanded={hasCandidates ? pickerOpen : undefined}
                    accessibilityHint={hasCandidates ? t('common.change') : undefined}
                    onPress={hasCandidates ? () => setPickerOpen((open) => !open) : undefined}
                />
                {props.selection.selectedOrigin ? (
                    <Item
                        testID={clearTestID}
                        title={t('settingsPlugins.targetSelection.clear')}
                        accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${clearAccessibilityScope}`}
                        onPress={() => { void settleSelection(props.selection.clearOrigin()); }}
                        showChevron={false}
                    />
                ) : null}
                {settlementError ? (
                    <Item
                        testID={props.testIDPrefix ? `${props.testIDPrefix}.settlementError` : undefined}
                        title={settlementError}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {pickerOpen && hasCandidates ? (
                <PluginOriginPickerGroups candidates={props.selection.candidates} machineCandidates={machineCandidates}>
                {(groups) => <ServerScopedMachineSelector
                    groups={groups}
                    selectedMachineId={selectedOrigin ? getPluginMachineExecutionOriginRef(selectedOrigin).machineId : null}
                    selectedServerId={selectedOrigin?.serverIdentityId ?? null}
                    onSelect={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)); }}
                    resolveMachineAvailability={(machine) => ({
                        detail: resolvePickerRowDetail(machine),
                        selectable: isPluginMachineExecutionOriginCandidateSelectable(machine.candidate),
                    })}
                    getMachineKey={(machine) => exactOriginKey(machine.origin)}
                    isMachineSelected={(machine) => exactOriginsEqual(selectedOrigin, machine.origin)}
                    testIdPrefix={props.testIDPrefix}
                />}
                </PluginOriginPickerGroups>
            ) : null}
        </>
    );
}
