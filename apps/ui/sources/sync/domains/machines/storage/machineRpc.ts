import {
    HappierStorageSummaryV1Schema, MachineStorageCategoryListResultV1Schema,
    MachineStorageWatchInputV1Schema, MachineStorageWatchResultV1Schema,
    type HappierStorageCategoryIdV1, type HappierStorageSummaryV1, type MachineStorageCategoryListResultV1, type MachineStorageWatchResultV1,
    MachineStoragePileResultV1Schema, PileReviewV1Schema, PileApplyResultV1Schema, TrashEmptyResultV1Schema, TrashRestoreResultV1Schema,
    MachineStorageItemsListResultV1Schema, MachineStorageSuggestionsDeclineResultV1Schema,
    type MachineStoragePileResultV1, type MachineStoragePileSetInputV1, type MachineStorageItemsCheckInputV1,
    type MachineStorageTrashMoveInputV1, type MachineStorageDeleteNowInputV1, type MachineStorageTrashEmptyInputV1,
    type MachineStorageTrashRestoreInputV1, type MachineStorageWorktreesListInputV1, type MachineStorageSuggestionsListInputV1,
    type MachineStorageSuggestionsDeclineInputV1,
    DiskScanStateV1Schema, MachineStorageScanGetResultV1Schema, type DiskScanStateV1, type MachineStorageScanGetResultV1,
    type MachineStorageScanStartInputV1, type MachineStorageScanGetInputV1, type MachineStorageScanCancelInputV1,
    type MachineStorageScanSkipInputV1, type MachineStorageProtectedAddInputV1,
    type MachineStorageItemsListResultV1, type PileReviewV1, type PileApplyResultV1, type TrashRestoreResultV1, type TrashEmptyResultV1,
} from '@happier-dev/protocol/storage/storageV1';
import { MachineResourcesPolicyMutationResultV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineStorageActionId } from '@happier-dev/protocol/actions/specs/storage';
import { createRpcCallError, readRpcErrorCode, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { ActionApprovalRequestCreatedResultSchema, isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { isMachineDaemonRpcUnsupportedError } from '../machineDaemonRpcErrors';

export type MachineStorageKey = Readonly<{ machineId: string; serverId?: string | null; expectedAccountId?: string | null; daemonStateVersion?: number | null }>;
export type MachineStorageReadInput = MachineStorageKey & Readonly<{
    signal?: AbortSignal;
}>;
export type MachineStorageCategoryInput = MachineStorageReadInput & Readonly<{ categoryId: HappierStorageCategoryIdV1; cursor?: string }>;
export type MachineStorageRefreshInput = MachineStorageReadInput & Readonly<{ categoryId?: HappierStorageCategoryIdV1 }>;
export type MachineStorageWatchInput = MachineStorageReadInput & Readonly<{ sinceRevision?: number }>;
type ScopedInput<T> = MachineStorageReadInput & Omit<T, 'machineId' | 'serverId'>;
export type MachineStoragePileSetInput = ScopedInput<MachineStoragePileSetInputV1>;
export type MachineStorageScanInput = ScopedInput<MachineStorageScanGetInputV1>;
export type MachineStorageScanStartInput = ScopedInput<MachineStorageScanStartInputV1>;
export type MachineStorageScanCancelInput = ScopedInput<MachineStorageScanCancelInputV1>;
export type MachineStorageScanSkipInput = ScopedInput<MachineStorageScanSkipInputV1>;
export type MachineStorageItemsInput = MachineStorageReadInput & Readonly<{
    list: 'worktrees' | 'suggestions';
    projectId?: string;
    filter?: MachineStorageWorktreesListInputV1['filter'];
    group?: MachineStorageSuggestionsListInputV1['group'];
    quickestForVolume?: string;
}>;
export type MachineStorageCheckInput = ScopedInput<MachineStorageItemsCheckInputV1>;
export type MachineStorageApplyItem = Readonly<{ ref: MachineStorageTrashMoveInputV1['items'][number]['ref']; expect: string;
    claimedVerdict?: MachineStorageTrashMoveInputV1['items'][number]['claimedVerdict']; reason?: MachineStorageTrashMoveInputV1['items'][number]['reason'] }>;
export type MachineStorageApplyInput = MachineStorageReadInput & Readonly<{ mode: 'trash' | 'delete'; items: readonly MachineStorageApplyItem[] }>;
export type MachineStorageTrashMoveInput = ScopedInput<MachineStorageTrashMoveInputV1>;
/** `reviewedByPerson`: the person just confirmed these exact items in the review sheet; it never enters the Action input. */
export type MachineStorageDeleteNowInput = ScopedInput<MachineStorageDeleteNowInputV1> & Readonly<{ reviewedByPerson?: boolean }>;
export type MachineStorageTrashEmptyInput = ScopedInput<MachineStorageTrashEmptyInputV1>;
export type MachineStorageTrashRestoreInput = ScopedInput<MachineStorageTrashRestoreInputV1>;
export type MachineStorageResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: 'older_happier' | 'request_failed' | 'invalid_response' | 'approval_requested' | 'declined' }>;
export type MachineStorageClients = Readonly<{
    summaryClient: (input: MachineStorageReadInput) => Promise<MachineStorageResult<HappierStorageSummaryV1>>;
    categoryClient: (input: MachineStorageCategoryInput) => Promise<MachineStorageResult<MachineStorageCategoryListResultV1>>;
    refreshClient: (input: MachineStorageRefreshInput) => Promise<MachineStorageResult<HappierStorageSummaryV1>>;
    watchClient: (input: MachineStorageWatchInput) => Promise<MachineStorageResult<MachineStorageWatchResultV1>>;
    pileClient?: (input: MachineStorageReadInput) => Promise<MachineStorageResult<MachineStoragePileResultV1>>;
    pileSetClient?: (input: MachineStoragePileSetInput) => Promise<MachineStorageResult<MachineStoragePileResultV1>>;
    scanClient?: (input: MachineStorageScanInput) => Promise<MachineStorageResult<MachineStorageScanGetResultV1>>;
    scanStartClient?: (input: MachineStorageScanStartInput) => Promise<MachineStorageResult<DiskScanStateV1>>;
    scanCancelClient?: (input: MachineStorageScanCancelInput) => Promise<MachineStorageResult<DiskScanStateV1>>;
    scanSkipClient?: (input: MachineStorageScanSkipInput) => Promise<MachineStorageResult<DiskScanStateV1>>;
    itemsClient?: (input: MachineStorageItemsInput) => Promise<MachineStorageResult<MachineStorageItemsListResultV1>>;
    checkClient?: (input: MachineStorageCheckInput) => Promise<MachineStorageResult<PileReviewV1>>;
    trashMoveClient?: (input: MachineStorageTrashMoveInput) => Promise<MachineStorageResult<PileApplyResultV1>>;
    deleteNowClient?: (input: MachineStorageDeleteNowInput) => Promise<MachineStorageResult<PileApplyResultV1>>;
    trashRestoreClient?: (input: MachineStorageTrashRestoreInput) => Promise<MachineStorageResult<TrashRestoreResultV1>>;
    trashEmptyClient?: (input: MachineStorageTrashEmptyInput) => Promise<MachineStorageResult<TrashEmptyResultV1>>;
}>;

async function result<T>(input: MachineStorageReadInput, request: () => Promise<unknown>, parse: (raw: unknown) => { success: true; data: T } | { success: false }): Promise<MachineStorageResult<T>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const raw = await request();
        // The transport owns cancellation settlement. A consumed acknowledgement
        // is still the operation's result when the caller retires afterward.
        if (isRpcMethodNotFoundResult(raw)) return { ok: false, reason: 'older_happier' };
        // The Action's own approval setting asked first: it runs once someone approves it.
        if (ActionApprovalRequestCreatedResultSchema.safeParse(raw).success) return { ok: false, reason: 'approval_requested' };
        const parsed = parse(raw);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid_response' };
    } catch (error) {
        return { ok: false, reason: isMachineDaemonRpcUnsupportedError(error) ? 'older_happier'
            : isActionApprovalDeclinedErrorCode(readRpcErrorCode(error)) ? 'declined'
            : readRpcErrorCode(error) === 'invalid_action_output' ? 'invalid_response' : 'request_failed' };
    }
}

let actionExecute: FrontDoorActionExecute | undefined;
async function execute(input: MachineStorageReadInput & Readonly<{ reviewedByPerson?: boolean }>, actionId: MachineStorageActionId, extra: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    if (!actionExecute) actionExecute = (await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')).createFrontDoorActionExecute();
    const outcome = await actionExecute(actionId, {
        machineId: input.machineId, ...(input.serverId ? { serverId: input.serverId } : {}), ...extra,
    }, { surface: 'ui', ...(input.serverId ? { serverId: input.serverId } : {}),
        ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}), ...(input.signal ? { signal: input.signal } : {}),
        // A completed review of this exact Action replaces the default confirmation; explicit Action settings still apply.
        ...(input.reviewedByPerson ? { authority: 'present_user' as const, presentUserConfirmation: { actionId } } : {}) });
    if (!outcome.ok) throw createRpcCallError({ error: outcome.error, errorCode: outcome.errorCode });
    return outcome.result;
}

export function fetchMachineStorageSummaryViaAction(input: MachineStorageReadInput): Promise<MachineStorageResult<HappierStorageSummaryV1>> {
    return result(input, () => execute(input, 'machines.storage.summary.get'), raw => HappierStorageSummaryV1Schema.safeParse(raw));
}
export function fetchMachineStorageCategoryViaAction(input: MachineStorageCategoryInput): Promise<MachineStorageResult<MachineStorageCategoryListResultV1>> {
    return result(input, () => execute(input, 'machines.storage.category.list', { categoryId: input.categoryId, ...(input.cursor ? { cursor: input.cursor } : {}) }), raw => MachineStorageCategoryListResultV1Schema.safeParse(raw));
}
export function refreshMachineStorageSizeViaAction(input: MachineStorageRefreshInput): Promise<MachineStorageResult<HappierStorageSummaryV1>> {
    return result(input, () => execute(input, 'machines.storage.size.refresh', input.categoryId ? { categoryId: input.categoryId } : {}), raw => HappierStorageSummaryV1Schema.safeParse(raw));
}
export function fetchMachineStoragePileViaAction(input: MachineStorageReadInput) {
    return result(input, () => execute(input, 'machines.storage.pile.get'), raw => MachineStoragePileResultV1Schema.safeParse(raw));
}
/** Runtime scope and cancellation fields never enter the strict Action input. */
function fields<T extends MachineStorageReadInput>(input: T) {
    const { machineId: _machine, serverId: _server, expectedAccountId: _account, daemonStateVersion: _version, signal: _signal, reviewedByPerson: _reviewed, ...payload } = input as T & { reviewedByPerson?: boolean };
    return payload;
}
export function setMachineStoragePileViaAction(input: MachineStoragePileSetInput) {
    return result(input, () => execute(input, 'machines.storage.pile.set', fields(input)), raw => MachineStoragePileResultV1Schema.safeParse(raw));
}
export function checkMachineStorageItemsViaAction(input: ScopedInput<MachineStorageItemsCheckInputV1>) {
    return result(input, () => execute(input, 'machines.storage.items.check', fields(input)), raw => PileReviewV1Schema.safeParse(raw));
}
export function moveMachineStorageToTrashViaAction(input: ScopedInput<MachineStorageTrashMoveInputV1>) {
    return result(input, () => execute(input, 'machines.storage.trash.move', fields(input)), raw => PileApplyResultV1Schema.safeParse(raw));
}
export function deleteMachineStorageNowViaAction(input: MachineStorageDeleteNowInput) {
    return result(input, () => execute(input, 'machines.storage.deleteNow', fields(input)), raw => PileApplyResultV1Schema.safeParse(raw));
}
export function emptyMachineStorageTrashViaAction(input: ScopedInput<MachineStorageTrashEmptyInputV1>) {
    return result(input, () => execute(input, 'machines.storage.trash.empty', fields(input)), raw => TrashEmptyResultV1Schema.safeParse(raw));
}
export function restoreMachineStorageTrashViaAction(input: ScopedInput<MachineStorageTrashRestoreInputV1>) {
    return result(input, () => execute(input, 'machines.storage.trash.restore', fields(input)), raw => TrashRestoreResultV1Schema.safeParse(raw));
}
export function fetchMachineStorageWorktreesViaAction(input: ScopedInput<MachineStorageWorktreesListInputV1>) {
    return result(input, () => execute(input, 'machines.storage.worktrees.list', fields(input)), raw => MachineStorageItemsListResultV1Schema.safeParse(raw));
}
export function fetchMachineStorageSuggestionsViaAction(input: ScopedInput<MachineStorageSuggestionsListInputV1>) {
    return result(input, () => execute(input, 'machines.storage.suggestions.list', fields(input)), raw => MachineStorageItemsListResultV1Schema.safeParse(raw));
}
/** Worktrees or Suggestions as one list read; `list` picks the Action and never enters its strict input. */
export function fetchMachineStorageItemsViaAction(input: MachineStorageItemsInput) {
    const { list, ...rest } = input;
    return list === 'worktrees' ? fetchMachineStorageWorktreesViaAction(rest) : fetchMachineStorageSuggestionsViaAction(rest);
}
export function declineMachineStorageSuggestionsViaAction(input: ScopedInput<MachineStorageSuggestionsDeclineInputV1>) {
    return result(input, () => execute(input, 'machines.storage.suggestions.decline', fields(input)), raw => MachineStorageSuggestionsDeclineResultV1Schema.safeParse(raw));
}
export function fetchMachineStorageScanViaAction(input: MachineStorageScanInput) {
    return result(input, () => execute(input, 'machines.storage.scan.get', fields(input)), raw => MachineStorageScanGetResultV1Schema.safeParse(raw));
}
export function startMachineStorageScanViaAction(input: MachineStorageScanStartInput) {
    return result(input, () => execute(input, 'machines.storage.scan.start', fields(input)), raw => DiskScanStateV1Schema.safeParse(raw));
}
export function cancelMachineStorageScanViaAction(input: MachineStorageScanCancelInput) {
    return result(input, () => execute(input, 'machines.storage.scan.cancel', fields(input)), raw => DiskScanStateV1Schema.safeParse(raw));
}
export function skipMachineStorageScanPathViaAction(input: MachineStorageScanSkipInput) {
    return result(input, () => execute(input, 'machines.storage.scan.skip', fields(input)), raw => DiskScanStateV1Schema.safeParse(raw));
}
export function addMachineStorageProtectedFolderViaAction(input: ScopedInput<MachineStorageProtectedAddInputV1>) {
    return result(input, () => execute(input, 'machines.storage.protected.add', fields(input)), raw => MachineResourcesPolicyMutationResultV1Schema.safeParse(raw));
}
export function removeMachineStorageProtectedFolderViaAction(input: ScopedInput<MachineStorageProtectedAddInputV1>) {
    return result(input, () => execute(input, 'machines.storage.protected.remove', fields(input)), raw => MachineResourcesPolicyMutationResultV1Schema.safeParse(raw));
}
export function watchMachineStorageViaMachineRpc(input: MachineStorageWatchInput): Promise<MachineStorageResult<MachineStorageWatchResultV1>> {
    const payload = MachineStorageWatchInputV1Schema.parse({ machineId: input.machineId,
        ...(input.serverId ? { serverId: input.serverId } : {}), ...(input.sinceRevision === undefined ? {} : { sinceRevision: input.sinceRevision }) });
    return result(input, () => machineRpcWithServerScope({ machineId: input.machineId, serverId: input.serverId,
        ...(input.expectedAccountId ? { accountId: input.expectedAccountId } : {}), method: RPC_METHODS.DAEMON_STORAGE_WATCH,
        payload, ...(input.signal ? { signal: input.signal } : {}) }), raw => MachineStorageWatchResultV1Schema.safeParse(raw));
}
