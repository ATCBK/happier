import type { Machine } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { computeConnectedServiceQuotaErrorBackoffMs } from '@/sync/domains/connectedServices/connectedServiceQuotaErrorBackoff';
import { isMachineReachable, readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';

/** Current servers publish persisted usage. Only the negotiated predecessor transport needs healthy acquisition. */
export function getUsageProjectionNextReadAtMs(input: Readonly<{
    consecutiveErrors: number;
    legacyStaleAfterMs?: number;
}>): number {
    if (input.consecutiveErrors > 0) return Date.now() + computeConnectedServiceQuotaErrorBackoffMs(input.consecutiveErrors);
    return input.legacyStaleAfterMs === undefined ? Number.POSITIVE_INFINITY
        : Date.now() + Math.max(30_000, Math.trunc(input.legacyStaleAfterMs));
}

/**
 * Acquisition currentness shared by Usage's admitted-reference and provider-row projections.
 * It owns no data or authority: readers retain their credential, mode and generation fences.
 * A wake during a read remains pending until settlement, including during a manual refresh.
 */
export function observeUsageProjection(input: Readonly<{
    serverId: string;
    /** The caller already awaited an admitted read before attaching this observation. */
    initialReadCompleted?: boolean;
    read(): Promise<unknown>;
    busy(): boolean;
    nextReadAtMs(): number;
    /** Aging a retained observation updates presentation without another GET. */
    presentationDeadlineMs?(): number | undefined;
    publish?(): void;
}>): Readonly<{ reconcile(): void; invalidate(): void; dispose(): void }> {
    let disposed = false;
    let pending = input.initialReadCompleted !== true;
    let active = isRuntimeActive();
    let timer: ReturnType<typeof setTimeout> | null = null;
    function reconcile(): void {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (disposed || !isRuntimeActive() || input.busy()) return;
        if (pending) {
            pending = false;
            void input.read().then(reconcile, reconcile);
            return;
        }
        const readDeadline = input.nextReadAtMs();
        const presentationDeadline = input.presentationDeadlineMs?.();
        const deadline = Math.min(readDeadline, presentationDeadline !== undefined && presentationDeadline > Date.now()
            ? presentationDeadline : Number.POSITIVE_INFINITY);
        if (!Number.isFinite(deadline)) return;
        timer = setTimeout(() => {
            timer = null;
            // Timer chunks observe the same owner deadline; an early chunk is not aging or a GET.
            if (deadline > Date.now()) { reconcile(); return; }
            if (readDeadline <= Date.now()) invalidate();
            else { input.publish?.(); reconcile(); }
        }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    }
    function invalidate(): void { pending = true; reconcile(); }
    const detachHome = subscribeHomeAccountChange(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, input.serverId)) return;
        if (event.source === 'connected' || (event.usageQueryAffects !== false
            && (event.entityIds === undefined || event.entityIds.includes(PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1)
                || event.entityIds.includes('self')))) invalidate();
    });
    const detachRuntime = subscribeToRuntimeActiveChange(() => {
        const nextActive = isRuntimeActive();
        if (nextActive && !active) pending = true;
        active = nextActive;
        reconcile();
    });
    // Defer the initial read until the caller has assigned the observer to its retained entry.
    queueMicrotask(reconcile);
    return { reconcile, invalidate, dispose() {
        disposed = true;
        if (timer !== null) clearTimeout(timer);
        detachHome();
        detachRuntime();
    } };
}

export function getUsageQueryMachineInvalidationKey(machines: Readonly<Record<string, Machine>>, nowMs = Date.now(), scope?: ServerAccountScope | null): string {
    return JSON.stringify(Object.values(machines)
        .map(machine => [machine.id, readMachineName(machine), isMachineReplaced(machine),
            isMachineReachable(scope, machine, nowMs)] as const)
        .sort(([left], [right]) => left.localeCompare(right)));
}

/** State invalidation for the Account-owned Usage Resource; not a second data reader. */
export function subscribeUsageQueryStateInvalidation(invalidate: () => void): (() => void) | null {
    const readInputs = () => {
        const state = readRegisteredStorageState();
        return [state?.profileScope, state?.profile.connectedAccountsV4, state?.profile.connectedAccountGroupsV4,
            state?.machines, state?.settingsScope,
            state?.settings.experiments, state?.settings.featureToggles, state?.settings.usagePacingTargetsV1,
            state?.settings.usageCoachPreferencesV1, state?.settings.usageNightHoursV1, state?.settings.usageModelPriceOverridesV1] as const;
    };
    const readMachineFacts = (machines: ReturnType<typeof readInputs>[3], nowMs: number, scope: ServerAccountScope | null | undefined) => {
        let nextRefreshAtMs: number | null = null;
        for (const machine of Object.values(machines ?? {})) {
            const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
            if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
        }
        return { key: getUsageQueryMachineInvalidationKey(machines ?? {}, nowMs, scope), observedAtMs: nowMs, nextRefreshAtMs };
    };
    let observedInputs = readInputs();
    let observedMachineFacts = readMachineFacts(observedInputs[3], Date.now(), observedInputs[0]);
    let observedReachabilityRevision = readMachineRequestReachabilityRevision();
    const reconcile = () => {
        const inputs = readInputs();
        const nowMs = Date.now();
        // Retain the listener's already-observed projection before doing any
        // machine enumeration, parsing, sorting or serialization. Presence can
        // change without new rows, so use its canonical deadline (and clock rollback).
        const reachabilityRevision = readMachineRequestReachabilityRevision();
        const machineFactsCurrent = inputs[3] === observedInputs[3] && inputs[0]?.serverId === observedInputs[0]?.serverId
            && inputs[0]?.accountId === observedInputs[0]?.accountId
            && reachabilityRevision === observedReachabilityRevision && nowMs >= observedMachineFacts.observedAtMs
            && (observedMachineFacts.nextRefreshAtMs === null || nowMs < observedMachineFacts.nextRefreshAtMs);
        if (machineFactsCurrent && inputs.every((input, index) => input === observedInputs[index])) return;
        const machineFacts = machineFactsCurrent ? observedMachineFacts : readMachineFacts(inputs[3], nowMs, inputs[0]);
        const changed = machineFacts.key !== observedMachineFacts.key
            || inputs.some((input, index) => index !== 3 && input !== observedInputs[index]);
        observedInputs = inputs;
        observedMachineFacts = machineFacts;
        observedReachabilityRevision = reachabilityRevision;
        if (changed) invalidate();
    };
    const unwatchState = subscribeRegisteredStorageState(reconcile);
    const unwatchReachability = subscribeMachineRequestReachability(reconcile);
    return () => { unwatchState?.(); unwatchReachability(); };
}
