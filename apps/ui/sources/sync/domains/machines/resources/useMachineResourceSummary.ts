import * as React from 'react';
import { MachineResourceAttentionV1Schema, type MachineResourceAttentionV1, type MachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useMachineDaemonReadIdentities } from '../useMachineDaemonReadTarget';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { EMPTY_MACHINE_RESOURCE_STATE, isMachineResourceStateStale, machineResourceStore, type MachineResourceState } from './machineResourceStore';
import type { MachineResourceKey } from './machineRpc';

export type MachineResourceAvailability =
    | Readonly<{ kind: 'reporting'; summary: MachineResourceSummaryV1 | null; freshness: 'live' | 'held' | 'stale';
        /** A failed watch retains values while its existing observation lifecycle recovers. */
        readStatus?: 'slow' | 'error';
        /** Canonical attention is separate from transient metric values; absence is unknown. */
        attention?: MachineResourceAttentionV1 | null }>
    | Readonly<{ kind: 'never_sampled' }>
    | Readonly<{ kind: 'unavailable'; errorCode?: string }>
    | Readonly<{ kind: 'not_reported'; reason: 'older_happier' | 'unsupported' }>;

const NEVER_SAMPLED: MachineResourceAvailability = { kind: 'never_sampled' };
const OLDER_HAPPIER: MachineResourceAvailability = { kind: 'not_reported', reason: 'older_happier' };
const UNSUPPORTED: MachineResourceAvailability = { kind: 'not_reported', reason: 'unsupported' };
const UNAVAILABLE: MachineResourceAvailability = { kind: 'unavailable' };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The one reading of a held state's failed watch or read: surfaces say it from here, never from the raw status. */
export function readMachineResourceReadStatus(state: Pick<MachineResourceState, 'status'>): 'slow' | 'error' | undefined {
    return state.status === 'slow' || state.status === 'error' ? state.status : undefined;
}

/** Row-local read of already demanded state; this hook is deliberately passive. */
export function useMachineResourceSummary(input: MachineResourceKey): MachineResourceAvailability | null {
    const target = useMachineDaemonReadIdentities([input])[0]!;
    const presence = useMachinePresenceSummary(target.key.serverId, input.machineId);
    const selectMachine = React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => resolveServerScopedMachine(state, target.key.serverId, input.machineId), [input.machineId, target.key.serverId]);
    const machine = storage(selectMachine);
    const viewed = target.enabled;
    const key = React.useMemo(() => ({ ...target.key, view: 'summary' as const }), [target.key]);
    const subscribe = React.useCallback((listener: () => void) => machineResourceStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => target.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE, [key, target.accountMatches]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const stale = isMachineResourceStateStale(state, Date.now());
    const daemonState: unknown = machine?.daemonState;
    const publication = React.useMemo(() => {
        const resources = isRecord(daemonState) ? daemonState.resources : null;
        const vitals = isRecord(resources) ? resources.vitals : null;
        return isRecord(vitals) && (vitals.state === 'reporting' || vitals.state === 'unavailable')
            ? { state: vitals.state, reason: typeof vitals.reason === 'string' ? vitals.reason : null,
                since: typeof vitals.since === 'number' ? vitals.since : null } : null;
    }, [daemonState]);
    const publishedAttention = React.useMemo(() => {
        const resources = isRecord(daemonState) ? daemonState.resources : null;
        const parsed = MachineResourceAttentionV1Schema.safeParse(isRecord(resources) ? resources.attention : null);
        return parsed.success ? parsed.data : null;
    }, [daemonState]);
    React.useEffect(() => {
        if (publishedAttention) machineResourceStore.setPublishedAttention(key, publishedAttention);
    }, [key, publishedAttention, state.snapshot?.attention, state.snapshot?.sample?.sampledAt]);
    React.useEffect(() => {
        if (machine && key.expectedAccountId) machineResourceStore.daemonStateChanged(key, machine.daemonStateVersion);
    }, [key, machine?.daemonStateVersion]);
    const online = machine ? presence.reachability === 'reachable' : true;
    return React.useMemo<MachineResourceAvailability | null>(() => {
        if (!target.accountMatches) return null;
        if (state.status === 'not_reported') return OLDER_HAPPIER;
        if (publication?.reason === 'helper_missing' || state.snapshot?.reason === 'helper_missing') return UNSUPPORTED;
        if (state.status === 'error' && !state.summary) return state.errorCode ? { kind: 'unavailable', errorCode: state.errorCode } : UNAVAILABLE;
        if (state.snapshot?.state === 'reporting' && !state.snapshot.sample) return NEVER_SAMPLED;
        // An unanswered read (including metadata hydration) establishes no support fact.
        if (!state.snapshot && !publication) return null;
        // A publication can lag recovery; an authorized reporting answer is the live-value owner.
        const reportingAt = state.status === 'ready' && state.snapshot?.state === 'reporting'
            ? state.snapshot.sample?.sampledAt ?? null : null;
        const publishedReaderFailed = publication?.reason === 'reader_failed'
            && (reportingAt === null || (publication.since !== null && publication.since >= reportingAt));
        const readStatus = readMachineResourceReadStatus(state);
        const freshness = stale || publishedReaderFailed ? 'stale'
            : !viewed || !online || state.status === 'slow' || state.status === 'error' || state.snapshot?.state === 'unavailable' ? 'held' : 'live';
        return { kind: 'reporting', summary: state.summary, freshness,
            ...(readStatus ? { readStatus } : {}),
            attention: publishedAttention ?? state.snapshot?.attention ?? null };
    }, [machine, online, publication, publishedAttention, stale, state, target.accountMatches, viewed]);
}

/** A surface's retained summaries are being revalidated by the same demand owner. */
export function useMachineResourceRefreshing(inputs: readonly MachineResourceKey[]): boolean {
    const identities = useMachineDaemonReadIdentities(inputs);
    const keys = React.useMemo(() => identities.filter(identity => identity.accountMatches)
        .map(identity => ({ ...identity.key, view: 'summary' as const })), [identities]);
    const subscribe = React.useCallback((listener: () => void) => {
        const releases = keys.flatMap(key => [
            machineResourceStore.observe(key, listener),
            machineResourceStore.observeRefreshing(key, listener),
        ]);
        return () => { for (const release of releases) release(); };
    }, [keys]);
    const read = React.useCallback(() => keys.some(key => {
        const state = machineResourceStore.getState(key);
        return state.summary !== null && machineResourceStore.isRefreshing(key);
    }), [keys]);
    return React.useSyncExternalStore(subscribe, read, read);
}
