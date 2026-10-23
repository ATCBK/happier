import * as React from 'react';
import { shallow } from 'zustand/shallow';

import { isAutomationSessionCandidate, isAutomationSessionCandidateVisible } from '@/sync/domains/automations/isAutomationSessionCandidate';
import { getStorage } from '@/sync/domains/state/storage';
import type { WorkflowExistingSessionOption } from '@/sync/domains/workflows/workflowAuthoring';
import { resolveDisplayMachineIdForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import type { StorageState } from '@/sync/store/types';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ensureSessionMetadataInventoryForServerAccountScope } from '@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createOperationAccountCurrentnessSource } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { readSessionSnapshotsForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { serverFetch } from '@/sync/http/client';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { areServerProfileIdentifiersEquivalent, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { readSessionOwnerMetadataView, SESSION_OWNER_METADATA_PROJECTION } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { waitForServerReachable } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

type WorkflowSessionOptions = Readonly<{
    existingSessions: readonly WorkflowExistingSessionOption[];
    /** Every continuable Session on any Machine: what the Session drop target resolves against. */
    sessionDropCandidates: readonly WorkflowExistingSessionOption[];
}>;
type WorkflowSessionOptionsState = WorkflowSessionOptions & Readonly<{
    sessionOptionsStatus: 'loading' | 'ready' | 'error';
    /** Reads again after a reported failure, through the same inventory and snapshot owners; only while demanded. */
    retrySessionOptions: () => void;
}>;
type AcquisitionStatus = Readonly<{ acquisition: object | null; status: 'loading' | 'ready' | 'error' }>;

const NO_OPTIONS: readonly WorkflowExistingSessionOption[] = [];
const NO_ROWS: readonly SessionListRenderableSession[] = [];

function createUnopenedRowsSelector(serverId: string | null) {
    let previous = NO_ROWS;
    let lastRows: StorageState['sessionListRowsByServerId'] | undefined;
    let lastSessions: StorageState['sessions'] | undefined;
    return (state: StorageState) => {
        if (state.sessionListRowsByServerId === lastRows && state.sessions === lastSessions) return previous;
        lastRows = state.sessionListRowsByServerId;
        lastSessions = state.sessions;
        const rows = serverId === null ? NO_ROWS : Object.values(
            readSessionListRowsForServerId(state.sessionListRowsByServerId, serverId) ?? {},
        ).filter(row => isAutomationSessionCandidateVisible(row)
            && !areServerProfileIdentifiersEquivalent(state.sessions[row.id]?.serverId, serverId));
        // Activity publications do not change continuation facts. A new retained
        // owner projection does; its presence alone is not content admission.
        if (rows.length === previous.length && rows.every((row, i) => {
            const before = previous[i];
            return row.id === before.id && row.metadataVersion === before.metadataVersion
                && row.metadataLayoutVersion === before.metadataLayoutVersion && row.metadata === before.metadata
                && row.metadataUnavailable === before.metadataUnavailable && row.access === before.access
                && row[SESSION_OWNER_METADATA_PROJECTION] === before[SESSION_OWNER_METADATA_PROJECTION]
                && row.accessLevel === before.accessLevel && row.encryptedContentAvailability === before.encryptedContentAvailability;
        })) return previous;
        previous = rows;
        return previous;
    };
}

function sameOptions(left: readonly WorkflowExistingSessionOption[], right: readonly WorkflowExistingSessionOption[]) {
    return left.length === right.length && left.every((option, index) => {
        const other = right[index];
        return option.sessionId === other.sessionId && option.machineId === other.machineId && option.label === other.label;
    });
}

function createOptionsSelector(serverId: string | null, machineId: string | null) {
    // This hook owns the displayed options, not the Session/settings containers.
    // Keep the selected projection stable without retaining a second data source.
    let previous: WorkflowSessionOptions = { existingSessions: [], sessionDropCandidates: [] };
    let candidateInputs: Pick<StorageState, 'sessions' | 'settings' | 'isDataReady'> | null = null;
    let candidates: StorageState['sessions'][string][] = [];
    let projectionInputs: readonly unknown[] | null = null;
    return (state: StorageState): WorkflowSessionOptions => {
        // Subscribe the projection to its inputs, not to every root publication.
        // Target resolution also reads Machine and list-row facts through the
        // canonical resolver; those remain live even when Session records do not change.
        const inputs = [state.sessions, state.settings, state.isDataReady, state.machines,
            state.machineListByServerId, state.machineListStatusByServerId,
            state.sessionListRowsByServerId, state.getProjectForSession];
        if (projectionInputs !== null && shallow(inputs, projectionInputs)) return previous;
        projectionInputs = inputs;
        // Eligibility parses Agent/backend policy. Unrelated store publications
        // must not repeat it for every Session. Keep target attribution below
        // live: Machine, project and list-row changes can alter that answer
        // without changing a Session's eligibility.
        if (candidateInputs === null || candidateInputs.sessions !== state.sessions
            || candidateInputs.settings !== state.settings || candidateInputs.isDataReady !== state.isDataReady) {
            candidates = state.isDataReady ? Object.values(state.sessions).filter(session => (
                (serverId === null || areServerProfileIdentifiersEquivalent(session.serverId, serverId))
                && isAutomationSessionCandidate(session, state.settings)
            )) : [];
            candidateInputs = { sessions: state.sessions, settings: state.settings, isDataReady: state.isDataReady };
        }
        const options: WorkflowExistingSessionOption[] = [];
        for (const session of candidates) {
            const sessionMachineId = resolveDisplayMachineIdForSessionFromState({
                state, serverId: session.serverId, sessionId: session.id, metadata: session.metadata,
            });
            if (sessionMachineId.length === 0) continue;
            options.push({ sessionId: session.id, machineId: sessionMachineId, label: getSessionName(session) });
        }
        if (sameOptions(options, previous.sessionDropCandidates)) return previous;
        const existing = machineId === null ? options : options.filter(option => option.machineId === machineId);
        previous = { sessionDropCandidates: options,
            existingSessions: sameOptions(existing, previous.existingSessions) ? previous.existingSessions : existing };
        return previous;
    };
}

/**
 * The existing Sessions a workflow step or an Account trigger's prompt may continue (01 §5.5): the
 * canonical Automation Session candidacy, each with the exact Machine the canonical target owner
 * reads for it. Once a Machine is known only its Sessions are offered, because the coordinator
 * refuses a Session on another Machine.
 */
export function useWorkflowExistingSessionOptions(params: Readonly<{
    serverId: string | null;
    machineId: string | null;
    /** Demand for detailed acquisition; closed controls retain the current option projection. */
    enabled?: boolean;
}>): WorkflowSessionOptionsState {
    const { serverId, machineId } = params;
    const enabled = params.enabled !== false;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const [retries, setRetries] = React.useState(0);
    const retrySessionOptions = React.useCallback(() => setRetries(count => count + 1), []);
    // One acquisition per demand (or retry): an outcome never outlives the acquisition that
    // produced it, so a new demand starts as loading rather than as the last one's error.
    const acquisition = React.useMemo(() => ({}), [binding, enabled, retries]);
    const [inventory, setInventory] = React.useState<AcquisitionStatus>({ acquisition: null, status: 'ready' });
    React.useEffect(() => {
        if (!enabled || !binding) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        void (async () => {
            if (retries > 0) {
                const profile = getServerProfileById(binding.scope.serverId);
                if (!profile) throw new Error('Session inventory Home unavailable');
                const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: binding.scope.serverId });
                if (!credentials) throw new Error('Session inventory credentials unavailable');
                // The existing transport owner retains carrier selection, probes
                // and recovery cadence. Retry remains loading until it verifies
                // reachability or this demand/Account leaves; no chooser timer.
                await waitForServerReachable({ serverUrl: profile.serverUrl, token: credentials.token, signal: controller.signal });
            }
            throwIfAborted(controller.signal);
            if (!binding.isCurrent()) return;
            await ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding,
                signal: controller.signal });
        })().then(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setInventory({ acquisition, status: 'ready' });
        }).catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setInventory({ acquisition, status: 'error' });
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [acquisition, binding, enabled, retries]);
    const inventoryStatus = !binding ? 'ready' : inventory.acquisition === acquisition ? inventory.status : 'loading';

    const unopenedSelector = React.useMemo(() => createUnopenedRowsSelector(serverId), [serverId]);
    const unopenedRows = getStorage()(unopenedSelector);
    const settings = getStorage()(state => unopenedRows.length > 0 ? state.settings : null);
    // Only the displayed option projection is local. Session inventory, paging,
    // read batching, crypto and currentness stay with the existing Session owners.
    const [unopened, setUnopened] = React.useState<Readonly<{
        binding: typeof binding;
        options: readonly WorkflowExistingSessionOption[];
    }> & AcquisitionStatus>({ binding: null, options: NO_OPTIONS, acquisition: null, status: 'ready' });
    const snapshotAcquisition = React.useMemo(() => ({}), [acquisition, unopenedRows, settings]);
    React.useEffect(() => {
        // Bootstrap may publish partial rows while the shared inventory is paging.
        // Start the aggregate detail read only after that acquisition completes;
        // subsequent material row changes still refresh through this same owner.
        if (!enabled || !binding || inventoryStatus !== 'ready' || unopenedRows.length === 0) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        setUnopened(previous => ({ binding, options: previous.binding === binding ? previous.options : NO_OPTIONS,
            acquisition: snapshotAcquisition, status: 'loading' }));
        void (async () => {
            const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: binding.scope,
                activeRequest: (path, init) => serverFetch(path, init) });
            let currentness: ReturnType<typeof createOperationAccountCurrentnessSource> | undefined;
            try {
                const credentials = authority.context.credentials;
                if (!credentials) throw new Error('Session options credentials unavailable');
                const accountCurrentnessSource = createOperationAccountCurrentnessSource({ credentials, request: authority.request,
                    serverId: authority.scope.serverId });
                currentness = accountCurrentnessSource;
                const isCurrent = () => !controller.signal.aborted && binding.isCurrent() && accountCurrentnessSource.isCurrent();
                const accountCurrentness = await accountCurrentnessSource.read();
                if (!isCurrent()) return;
                const state = getStorage().getState();
                const accountSettings = readAccountSettingsForScope({ scope: binding.scope,
                    focusedScope: state.settingsScope, focusedSettings: settings ?? state.settings });
                const optionsById = new Map<string, WorkflowExistingSessionOption>();
                let failed = false;
                const publishOption = (sessionId: string, option: WorkflowExistingSessionOption | undefined) => {
                    if (option) optionsById.set(sessionId, option);
                    if (!isCurrent()) return;
                    setUnopened(previous => {
                        // Keep last-known options for not-yet-settled rows on
                        // refresh. Only a settled row may replace its answer.
                        const retained = previous.binding === binding ? previous.options : NO_OPTIONS;
                        const index = retained.findIndex(value => value.sessionId === sessionId);
                        if (index < 0 && !option) return previous;
                        const next = [...retained];
                        if (index < 0 && option) next.push(option);
                        else if (option) next[index] = option;
                        else next.splice(index, 1);
                        if (sameOptions(retained, next)) return previous;
                        return { binding, acquisition: snapshotAcquisition,
                            options: next, status: 'loading' };
                    });
                };
                const missingIds: string[] = [];
                for (const row of unopenedRows) {
                    const metadata = readSessionListRenderableOwnerMetadataView(row, {
                        requireAdmitted: { credentials, accountCurrentness, isCurrent },
                    });
                    if (!metadata) { missingIds.push(row.id); continue; }
                    let option: WorkflowExistingSessionOption | undefined;
                    if (isAutomationSessionCandidate({ ...row, ownerMetadataView: metadata }, accountSettings)) {
                        const sessionMachineId = resolveDisplayMachineIdForSessionFromState({ state: getStorage().getState(),
                            serverId: binding.scope.serverId, sessionId: row.id, metadata });
                        if (sessionMachineId) option = { sessionId: row.id, machineId: sessionMachineId, label: getSessionName(row) };
                    }
                    if (option) optionsById.set(row.id, option);
                }
                if (missingIds.length > 0) {
                    // The admitted cohort settles together, without N queued
                    // option-array copies. Missing rows keep their last answer
                    // until the exact owner settles each one progressively.
                    const missing = new Set(missingIds);
                    setUnopened(previous => {
                        const retained = new Map((previous.binding === binding ? previous.options : NO_OPTIONS)
                            .map(option => [option.sessionId, option]));
                        const options = unopenedRows.flatMap(row => {
                            const option = optionsById.get(row.id) ?? (missing.has(row.id) ? retained.get(row.id) : undefined);
                            return option ? [option] : [];
                        });
                        return { binding, acquisition: snapshotAcquisition,
                            options: sameOptions(previous.options, options) ? previous.options : options, status: 'loading' };
                    });
                    await readSessionSnapshotsForAuthority({ authority, sessionIds: missingIds,
                        includeTurns: false, signal: controller.signal, isCurrent, accountCurrentnessSource: currentness,
                        onResult: (sessionId, result) => {
                            let option: WorkflowExistingSessionOption | undefined;
                            if (!result.ok) failed = true;
                            else {
                                const session = result.snapshot.session;
                                if (isAutomationSessionCandidate(session, accountSettings)) {
                                    const sessionMachineId = resolveDisplayMachineIdForSessionFromState({ state: getStorage().getState(),
                                        serverId: binding.scope.serverId, sessionId, metadata: readSessionOwnerMetadataView(session) });
                                    if (sessionMachineId) option = { sessionId, machineId: sessionMachineId, label: getSessionName(session) };
                                }
                            }
                            publishOption(sessionId, option);
                        } });
                }
                await currentness.ensureCurrent();
                const options = unopenedRows.flatMap(row => {
                    const option = optionsById.get(row.id);
                    return option ? [option] : [];
                });
                if (isCurrent()) setUnopened(previous => ({ binding, acquisition: snapshotAcquisition,
                    options: sameOptions(previous.options, options) ? previous.options : options, status: failed ? 'error' : 'ready' }));
            } finally { currentness?.dispose(); await authority.release(); }
        })().catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setUnopened(previous => ({ ...previous, acquisition: snapshotAcquisition, status: 'error' }));
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [snapshotAcquisition, binding, enabled, inventoryStatus, unopenedRows, settings]);
    const unopenedStatus = unopened.acquisition === snapshotAcquisition ? unopened.status : 'loading';
    // Every Session the canonical candidacy owner can continue, on any Machine
    // of this server: the drop target needs them to state *why* a Session on
    // another Machine is refused (07 J19), while the picker offers only the
    // Where Machine's.
    const selector = React.useMemo(() => createOptionsSelector(serverId, machineId), [serverId, machineId]);
    const hydrated = getStorage()(selector);
    return React.useMemo<WorkflowSessionOptionsState>(() => {
        const ids = new Set(unopenedRows.map(row => row.id));
        const extra = unopened.binding === binding && binding?.isCurrent()
            ? unopened.options.filter(option => ids.has(option.sessionId)) : NO_OPTIONS;
        const candidates = extra.length ? [...hydrated.sessionDropCandidates, ...extra] : hydrated.sessionDropCandidates;
        return { sessionDropCandidates: candidates,
            existingSessions: extra.length ? candidates.filter(option => machineId === null || option.machineId === machineId) : hydrated.existingSessions,
            sessionOptionsStatus: !enabled ? 'ready' : serverId && resolution.kind !== 'bound'
                ? resolution.kind === 'resolving' ? 'loading' : 'error'
                : inventoryStatus === 'error' || unopenedRows.length > 0 && unopenedStatus === 'error' ? 'error'
                    : inventoryStatus === 'loading' || unopenedRows.length > 0 && unopenedStatus === 'loading' ? 'loading' : 'ready',
            retrySessionOptions };
    }, [binding, enabled, hydrated, inventoryStatus, machineId, resolution, retrySessionOptions, serverId, unopened, unopenedRows, unopenedStatus]);
}
