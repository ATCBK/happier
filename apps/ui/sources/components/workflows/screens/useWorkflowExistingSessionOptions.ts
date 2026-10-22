import * as React from 'react';

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
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotsForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { serverFetch } from '@/sync/http/client';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

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
        // Activity publications do not change continuation facts. The exact read
        // owner, not a display row's compact metadata, supplies those facts.
        if (rows.length === previous.length && rows.every((row, i) => {
            const before = previous[i];
            return row.id === before.id && row.metadataVersion === before.metadataVersion
                && row.metadataLayoutVersion === before.metadataLayoutVersion && row.metadata === before.metadata
                && row.metadataUnavailable === before.metadataUnavailable && row.access === before.access
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
    return (state: StorageState): WorkflowSessionOptions => {
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
        void ensureSessionMetadataInventoryForServerAccountScope({ scope: binding.scope, accountLifetime: binding,
            signal: controller.signal }).then(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setInventory({ acquisition, status: 'ready' });
        }).catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setInventory({ acquisition, status: 'error' });
        });
        return () => controller.abort();
    }, [acquisition, binding, enabled]);
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
        if (!enabled || !binding || unopenedRows.length === 0) return;
        const controller = new AbortController();
        const retirement = binding.onRetire(() => controller.abort());
        setUnopened(previous => ({ binding, options: previous.binding === binding ? previous.options : NO_OPTIONS,
            acquisition: snapshotAcquisition, status: 'loading' }));
        void (async () => {
            const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: binding.scope,
                activeRequest: (path, init) => serverFetch(path, init) });
            try {
                const results = await readSessionSnapshotsForAuthority({ authority, sessionIds: unopenedRows.map(row => row.id),
                    signal: controller.signal, isCurrent: binding.isCurrent });
                const state = getStorage().getState();
                const accountSettings = readAccountSettingsForScope({ scope: binding.scope,
                    focusedScope: state.settingsScope, focusedSettings: settings ?? state.settings });
                const options: WorkflowExistingSessionOption[] = [];
                let failed = false;
                for (const result of results.values()) {
                    if (!result.ok) { failed = true; continue; }
                    const session = result.snapshot.session;
                    if (!isAutomationSessionCandidate(session, accountSettings)) continue;
                    const sessionMachineId = resolveDisplayMachineIdForSessionFromState({ state: getStorage().getState(),
                        serverId: binding.scope.serverId, sessionId: session.id, metadata: session.metadata });
                    if (sessionMachineId) options.push({ sessionId: session.id, machineId: sessionMachineId, label: getSessionName(session) });
                }
                if (!controller.signal.aborted && binding.isCurrent()) setUnopened(previous => ({ binding, acquisition: snapshotAcquisition,
                    options: sameOptions(previous.options, options) ? previous.options : options, status: failed ? 'error' : 'ready' }));
            } finally { await authority.release(); }
        })().catch(() => {
            if (!controller.signal.aborted && binding.isCurrent()) setUnopened(previous => ({ ...previous, acquisition: snapshotAcquisition, status: 'error' }));
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [snapshotAcquisition, binding, enabled, unopenedRows, settings]);
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
