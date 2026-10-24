import type { Machine } from '@/sync/domains/state/storageTypes';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1, readConnectedServicesAccountChangeV1 } from '@happier-dev/protocol/changes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { computeConnectedServiceQuotaErrorBackoffMs } from '@/sync/domains/connectedServices/connectedServiceQuotaErrorBackoff';
import { isMachineReachable, readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isConnectedServiceUsageCapable, subscribeConnectedServiceRegistry } from '@/sync/domains/connectedServices/connectedServiceRegistry';

/** Current servers publish persisted usage. Only the negotiated predecessor transport needs healthy acquisition. */
export function getUsageProjectionNextReadAtMs(input: Readonly<{
    consecutiveErrors: number;
    legacyStaleAfterMs?: number;
}>): number {
    if (input.consecutiveErrors > 0) return Date.now() + computeConnectedServiceQuotaErrorBackoffMs(input.consecutiveErrors);
    return input.legacyStaleAfterMs === undefined ? Number.POSITIVE_INFINITY
        : Date.now() + Math.max(30_000, Math.trunc(input.legacyStaleAfterMs));
}

/** Detailed Profile/Settings and Machine changes arrive through their material-input subscriptions. */
export function isUsageProjectionHomeAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.source === 'connected' || event.usageQueryAffects !== false
        && (event.entityIds === undefined || event.entityIds.includes(PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1)
            || (event.changeKinds === undefined || event.changeKinds.includes('account'))
                && event.entityIds.some(entityId => readConnectedServicesAccountChangeV1({ kind: 'account', entityId }) !== null)
            || event.changeKinds === undefined && event.entityIds.includes('self'));
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
        if (isUsageProjectionHomeAccountChange(event)) invalidate();
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

export type UsageQueryMachineConsumers = Readonly<{
    /** Accounting source coverage consumes Machine names; quota and pool facts do not. */
    includeMachineNames?: boolean;
    poolMachineFilters: readonly (readonly string[])[];
    sessionMachineIds: readonly string[];
}>;

const NO_MACHINE_CONSUMERS: UsageQueryMachineConsumers = { poolMachineFilters: [], sessionMachineIds: [] };

function readUsageMachineFacts(machines: Readonly<Record<string, Machine>>, nowMs: number, scope?: ServerAccountScope | null) {
    return Object.values(machines).map(machine => ({ id: machine.id, name: readMachineName(machine),
        replaced: isMachineReplaced(machine), reachable: isMachineReachable(scope, machine, nowMs) }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

function selectUsagePoolMachine(facts: ReturnType<typeof readUsageMachineFacts>, machineIds: readonly string[]) {
    const eligible = facts.filter(machine => !machine.replaced && machine.reachable
        && (machineIds.length === 0 || machineIds.includes(machine.id)));
    return eligible.length === 1 ? { status: 'pending' as const, machineId: eligible[0]!.id }
        : eligible.length > 1 ? { status: 'unknown' as const }
            : { status: 'unsupported' as const, errorCode: 'no_machine' };
}

/** Pool reads and invalidation resolve the same current selector; ambiguity is not a machine identity. */
export function getUsageQueryPoolMachineSelection(machines: Readonly<Record<string, Machine>>, machineIds: readonly string[],
    scope: ServerAccountScope, nowMs = Date.now()) {
    return selectUsagePoolMachine(readUsageMachineFacts(machines, nowMs, scope), machineIds);
}

function consumedMachineKey(facts: ReturnType<typeof readUsageMachineFacts>, consumers: UsageQueryMachineConsumers): string {
    const byId = new Map(facts.map(machine => [machine.id, machine]));
    return JSON.stringify([
        consumers.includeMachineNames === false ? [] : facts.map(machine => [machine.id, machine.name]),
        consumers.poolMachineFilters.map(ids => selectUsagePoolMachine(facts, ids)),
        [...new Set(consumers.sessionMachineIds)].sort().map(id => [id, byId.get(id)?.replaced, byId.get(id)?.reachable]),
    ]);
}

export function getUsageQueryMachineInvalidationKey(machines: Readonly<Record<string, Machine>>, nowMs = Date.now(),
    scope?: ServerAccountScope | null, consumers: UsageQueryMachineConsumers = NO_MACHINE_CONSUMERS): string {
    return consumedMachineKey(readUsageMachineFacts(machines, nowMs, scope), consumers);
}

/** State invalidation for the Account-owned Usage Resource; not a second data reader. */
export function subscribeUsageQueryStateInvalidation(invalidate: () => void,
    readMachineConsumers: (machines: Readonly<Record<string, Machine>>) => UsageQueryMachineConsumers = () => NO_MACHINE_CONSUMERS): (() => void) | null {
    const readInputs = () => {
        const state = readRegisteredStorageState();
        return [state?.profileScope, state?.profile.connectedAccountsV4, state?.profile.connectedAccountGroupsV4,
            state?.machines, state?.settingsScope,
            state?.settings.experiments, state?.settings.featureToggles, state?.settings.usagePacingTargetsV1,
            state?.settings.usageCoachPreferencesV1, state?.settings.usageNightHoursV1, state?.settings.usageModelPriceOverridesV1] as const;
    };
    // Credential activity does not change quota facts or their admission. The
    // persisted Usage change signal separately wakes new provider observations.
    const readAccountInputs = (accounts: ReturnType<typeof readInputs>[1]) => accounts?.map(({ lastUsedAt: _lastUsedAt, ...account }) => account);
    const readMachineFacts = (machines: ReturnType<typeof readInputs>[3], nowMs: number, scope: ServerAccountScope | null | undefined) => {
        let nextRefreshAtMs: number | null = null;
        for (const machine of Object.values(machines ?? {})) {
            const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
            if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
        }
        return { facts: readUsageMachineFacts(machines ?? {}, nowMs, scope), observedAtMs: nowMs, nextRefreshAtMs };
    };
    let observedInputs = readInputs();
    const readUsageCapabilities = () => JSON.stringify(readRegisteredStorageState()?.profile.connectedAccountsV4
        .map(account => isConnectedServiceUsageCapable(account.ref.service)) ?? []);
    let observedUsageCapabilities = readUsageCapabilities();
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
        // Evaluate both projections against the same currently admitted demand.
        // A newly opened pool/Session must not itself look like a machine change
        // on the next unrelated store notification. Retained facts also preserve
        // the old request reachability after its canonical observation changes.
        const changed = !machineFactsCurrent && consumedMachineKey(machineFacts.facts, readMachineConsumers(inputs[3] ?? {}))
            !== consumedMachineKey(observedMachineFacts.facts, readMachineConsumers(observedInputs[3] ?? {}))
            // Profile/Settings hydration can replace these small admitted inputs
            // without changing Usage evidence. Compare only changed references;
            // ordinary store churn still exits before any projection work.
            || inputs.some((input, index) => index !== 3 && input !== observedInputs[index]
                && (index === 1 ? !sameStrictJsonValue(readAccountInputs(inputs[1]), readAccountInputs(observedInputs[1]))
                    : !sameStrictJsonValue(input, observedInputs[index])));
        observedInputs = inputs;
        observedUsageCapabilities = readUsageCapabilities();
        observedMachineFacts = machineFacts;
        observedReachabilityRevision = reachabilityRevision;
        if (changed) invalidate();
    };
    const unwatchState = subscribeRegisteredStorageState(reconcile);
    const unwatchReachability = subscribeMachineRequestReachability(reconcile);
    const unwatchRegistry = subscribeConnectedServiceRegistry(() => {
        const capabilities = readUsageCapabilities();
        if (capabilities === observedUsageCapabilities) return;
        observedUsageCapabilities = capabilities;
        invalidate();
    });
    return () => { unwatchState?.(); unwatchReachability(); unwatchRegistry(); };
}
