import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol';
import type { MachineStorageTrashMoveInputV1, PileApplyResultV1, TrashEmptyResultV1 } from '@happier-dev/protocol/storage/storageV1';

import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { executeMachineProcessesActionV1, executeMachineProcessesStartAgainV1 } from '@/sync/domains/machines/processes/machineProcessesActions';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { fetchMachineGuardViewViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import type { StoragePileBar } from '@/components/machines/storage/storagePileModel';
import {
  checkMachineStorageItemsViaAction,
  emptyMachineStorageTrashViaAction,
  moveMachineStorageToTrashViaAction,
  restoreMachineStorageTrashViaAction,
} from '@/sync/domains/machines/storage/machineRpc';
import {
  MachineProcessesCheckResultV1Schema,
  MachineProcessesStartAgainResultV1Schema,
  type MachineProcessesActionResultV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/machineProcesses';

import {
  readResourceProposalApproval,
  type ResourceProposalModel,
} from './readResourceProposalApproval';
import {
  buildResourceProposalNarrowedInput,
  resourceProposalApprovedKeys,
  deriveResourceProposalDisplay,
  describeResourceProposalRows,
  initialResourceProposalSelection,
  resourceProposalDeclinedOperands,
  resourceProposalSelectedBytes,
  selectAllSafeResourceProposal,
  toggleResourceProposalSelectAll,
  readResourceProposalProcessResult,
  type ResourceProposalCheck,
  type ResourceProposalDisplay,
  type ResourceProposalItemFacts,
  type ResourceProposalOutcome,
  type ResourceProposalRow,
} from './resourceProposalPresentation';

/** The decision operands the card hands to the one approval decision handler. */
export type ResourceProposalDecisionOptions = Readonly<{
  narrowedInput?: unknown;
  /** Items the person turned down, remembered by the storage owner after the decision lands. */
  declinedItems?: readonly Readonly<Record<string, unknown>>[];
}>;

export type ResourceProposalController = Readonly<{
  model: ResourceProposalModel;
  rows: readonly ResourceProposalRow[];
  check: ResourceProposalCheck;
  display: ResourceProposalDisplay;
  /** The items the approval actually carried into execution (the person's narrowed set). */
  approvedKeys: ReadonlySet<string>;
  selectedCount: number;
  selectedBytes: number;
  /** Approval stays withheld at zero, while the first check runs, and while the facts are stale. */
  approveWithheld: boolean;
  toggle: (key: string) => void;
  confirmKeep: (key: string) => void;
  toggleAll: () => void;
  selectAllSafe: () => void;
  checkAgain: () => void;
  decisionOptions: (
    decision: 'approve' | 'reject',
    choice?: Readonly<{ keepUndo?: boolean }>,
  ) => ResourceProposalDecisionOptions;
  emptyNow: (() => Promise<boolean>) | null;
  undo: (() => Promise<boolean>) | null;
  /** The declined request is shown again for a UI run; the request itself stays rejected. */
  reopened: boolean;
  /** Declined: show the items again (re-checked), without changing the rejected request. */
  reopen: (() => void) | null;
  /** Reopened: run the same Action from the UI as a new invocation. */
  runFromUi: (() => Promise<boolean>) | null;
  /** After a run: invoke the Action again for one skipped item. */
  retryItem: ((key: string) => Promise<boolean>) | null;
  retried: ReadonlyMap<string, ResourceProposalOutcome>;
  /** After a stop: the process owner's Start again. */
  startAgain: ((key: string) => Promise<boolean>) | null;
  startedAgain: ReadonlySet<string>;
  /** One receipt per retry that moved something: its own batch, with Undo and Empty now. */
  retryReceipts: readonly ResourceProposalRetryReceipt[];
}>;

type CheckClients = Readonly<{
  serverId: string | null;
  signal: AbortSignal;
}>;

async function checkStorage(
  model: ResourceProposalModel,
  clients: CheckClients,
): Promise<ReadonlyMap<string, ResourceProposalItemFacts> | null> {
  // The check takes the served references (item id + path); the daemon resolves identity afresh.
  const refs = model.items.map((item) => ({ itemId: item.key, path: item.path }));
  const result = await checkMachineStorageItemsViaAction({
    machineId: model.machineId,
    ...(clients.serverId ? { serverId: clients.serverId } : {}),
    refs,
    signal: clients.signal,
  });
  if (!result.ok) return null;
  const facts = new Map<string, ResourceProposalItemFacts>();
  for (const item of result.value.items) {
    const claim = model.items.find(
      (candidate) => candidate.key === item.ref.itemId,
    );
    if (!claim) continue;
    facts.set(claim.key, {
      key: claim.key,
      status: 'present',
      verdict: item.verdict,
      reason: item.reason,
      expect: item.expect,
      bytes: item.size.freesBytes,
      onDiskBytes:
        item.size.allocatedBytes > item.size.freesBytes
          ? item.size.allocatedBytes
          : null,
      loses: item.loses ?? [],
      changed:
        item.expect !== claim.operand.expect ||
        item.verdict !== claim.claimedVerdict,
    });
  }
  for (const staying of result.value.staying) {
    const claim = model.items.find(
      (candidate) => candidate.key === staying.item.itemId,
    );
    if (!claim || facts.has(claim.key)) continue;
    facts.set(claim.key, {
      key: claim.key,
      status: staying.reason.code === 'missing' ? 'gone' : 'refused',
      verdict: claim.claimedVerdict,
      reason: staying.reason,
      expect: claim.operand.expect,
      bytes: null,
      onDiskBytes: null,
      loses: [],
      changed: true,
    });
  }
  for (const claim of model.items) {
    if (facts.has(claim.key)) continue;
    facts.set(claim.key, {
      key: claim.key,
      status: 'gone',
      verdict: claim.claimedVerdict,
      reason: null,
      expect: claim.operand.expect,
      bytes: null,
      onDiskBytes: null,
      loses: [],
      changed: true,
    });
  }
  return facts;
}

async function checkProcesses(
  model: ResourceProposalModel,
  clients: CheckClients,
): Promise<ReadonlyMap<string, ResourceProposalItemFacts> | null> {
  if (!clients.serverId) return null;
  const account = await captureLazyActionAccountContext(
    clients.serverId,
    clients.signal,
  );
  try {
    const outcome = await executeMachineProcessesActionV1(
      'machines.processes.check',
      {
        machineId: model.machineId,
        serverId: clients.serverId,
        refs: model.items.map((item) => item.key),
      },
      {
        serverId: clients.serverId,
        expectedAccountId: account.accountId,
        signal: clients.signal,
      },
    );
    if (!outcome.ok) return null;
    const parsed = MachineProcessesCheckResultV1Schema.safeParse(
      outcome.result,
    );
    if (!parsed.success) return null;
    const guard = await fetchMachineGuardViewViaAction({
      machineId: model.machineId, serverId: clients.serverId,
      expectedAccountId: account.accountId, signal: clients.signal,
    });
    if (!guard.ok) return null;
    const facts = new Map<string, ResourceProposalItemFacts>();
    for (const claim of model.items) {
      const check = parsed.data.checks.find(
        (candidate) => candidate.ref === claim.key,
      );
      const claimedLevel = model.actionId === 'machines.processes.leftBehind.cleanUp' ? 'left_behind' : (
        claim.operand.expect as { level?: unknown } | undefined
      )?.level;
      const present = Boolean(check?.present && check.identityEqual);
      const keptByGuard = guard.value.ladder.excluded.find(entry =>
        entry.kind === 'session' && entry.processRef === claim.key);
      facts.set(claim.key, {
        key: claim.key,
        status: present ? 'present' : 'gone',
        verdict:
          keptByGuard ? 'keep' : check?.level === 'proven' || check?.level === 'left_behind'
            ? 'safe'
            : check?.level === 'likely'
              ? 'caution'
              : claim.claimedVerdict,
        reason: null,
        expect: model.actionId === 'machines.processes.leftBehind.cleanUp' ? undefined : check?.level
          ? {
              level: check.level,
              ...(check.owner ? { owner: check.owner } : {}),
            }
          : claim.operand.expect,
        bytes: check?.memoryBytes ?? null,
        onDiskBytes: null,
        loses: [],
        ...(keptByGuard ? { keptByGuard } : {}),
        changed: !present || check?.level !== claimedLevel,
      });
    }
    return facts;
  } finally {
    account.dispose();
  }
}

/**
 * The proposal card's state (plan 60 AGW-6/7/8): one batched safe check on view and on Check again
 * (no timer), the card-local ticks that become the approval's narrowing operand (never pile
 * membership), and the receipt's ways back. No persisted state of its own.
 */
export function useResourceProposalCheck(
  approval: ApprovalRequest | null,
  serverIdHint: string | null,
): ResourceProposalController | null {
  const model = React.useMemo(
    () => (approval ? readResourceProposalApproval(approval) : null),
    [approval],
  );
  const serverId = model?.serverId ?? serverIdHint;
  const isOpen = approval?.status === 'open';
  const [check, setCheck] = React.useState<ResourceProposalCheck>(
    () =>
      ({
        kind: isOpen ? 'checking' : 'unavailable',
        previous: null,
      }) as ResourceProposalCheck,
  );
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() =>
    model ? initialResourceProposalSelection(model) : new Set(),
  );
  const [confirmedKeep, setConfirmedKeep] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [emptied, setEmptied] = React.useState<TrashEmptyResultV1 | null>(null);
  const [restored, setRestored] = React.useState(false);
  const [reopened, setReopened] = React.useState(false);
  const [localRun, setLocalRun] = React.useState<ResourceProposalLocalRun | null>(null);
  const localRunRef = React.useRef(localRun);
  localRunRef.current = localRun;
  const [retried, setRetried] = React.useState<ReadonlyMap<string, ResourceProposalOutcome>>(() => new Map());
  const [retryReceipts, setRetryReceipts] = React.useState<readonly RetryReceiptState[]>([]);
  const [startedAgain, setStartedAgain] = React.useState<ReadonlySet<string>>(() => new Set());
  const runRef = React.useRef<AbortController | null>(null);

  const runCheck = React.useCallback(
    (acknowledged: boolean) => {
      if (!model) return;
      runRef.current?.abort();
      const controller = new AbortController();
      runRef.current = controller;
      const previousFacts = new Map(rowsRef.current.map(row => [row.item.key, row.facts]));
      setCheck((previous) => ({
        kind: 'checking',
        previous:
          previous.kind === 'ready'
            ? previous.facts
            : previous.kind === 'checking'
              ? previous.previous
              : null,
      }));
      const read = model.kind === 'storage' ? checkStorage : checkProcesses;
      void read(model, { serverId, signal: controller.signal }).then(
        (facts) => {
          if (controller.signal.aborted) return;
          setCheck(
            facts
              ? { kind: 'ready', facts, checkedAt: Date.now(), acknowledged }
              : { kind: 'unavailable' },
          );
          if (facts) {
            // Confirmation names a current loss. A different owner/work state needs fresh consent.
            setConfirmedKeep(current => new Set([...current].filter(key => {
              const before = previousFacts.get(key);
              const after = facts.get(key);
              if (!before || !after || after.status !== 'present' || after.verdict !== 'keep') return false;
              return before.verdict === after.verdict
                && JSON.stringify(before.expect) === JSON.stringify(after.expect)
                && JSON.stringify(before.reason) === JSON.stringify(after.reason)
                && JSON.stringify(before.loses) === JSON.stringify(after.loses)
                && before.keptByGuard?.ref === after.keptByGuard?.ref
                && before.keptByGuard?.label === after.keptByGuard?.label
                && before.keptByGuard?.reason === after.keptByGuard?.reason;
            })));
            // A changed item keeps its tick only while it is still something the person can approve.
            setSelection(
              (current) =>
                new Set(
                  [...current].filter((key) => {
                    const fact = facts.get(key);
                    return (
                      !fact ||
                      (fact.status === 'present' &&
                        fact.verdict !== 'forbidden' &&
                        fact.verdict !== 'check')
                    );
                  }),
                ),
            );
          }
        },
        () => {
          if (!controller.signal.aborted) setCheck({ kind: 'unavailable' });
        },
      );
    },
    [model, serverId],
  );

  React.useEffect(() => {
    if (!isOpen) return;
    runCheck(false);
    return () => runRef.current?.abort();
  }, [isOpen, runCheck]);

  const rows = React.useMemo(
    () =>
      model
        ? describeResourceProposalRows(model, check, selection, confirmedKeep)
        : [],
    [check, confirmedKeep, model, selection],
  );
  const toggle = React.useCallback((key: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const confirmKeep = React.useCallback((key: string) => {
    setConfirmedKeep((current) => new Set(current).add(key));
    setSelection((current) => new Set(current).add(key));
  }, []);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  const toggleAll = React.useCallback(
    () => setSelection(toggleResourceProposalSelectAll(rowsRef.current)),
    [],
  );
  const selectAllSafe = React.useCallback(
    () => setSelection(selectAllSafeResourceProposal(rowsRef.current)),
    [],
  );
  const checkAgain = React.useCallback(() => runCheck(true), [runCheck]);
  const decisionOptions = React.useCallback(
    (
      decision: 'approve' | 'reject',
      choice?: Readonly<{ keepUndo?: boolean }>,
    ): ResourceProposalDecisionOptions => {
      if (!model) return {};
      const declinedItems =
        model.kind === 'storage'
          ? resourceProposalDeclinedOperands(rowsRef.current, decision)
          : undefined;
      if (decision === 'reject') return { declinedItems };
      const narrowedInput = buildResourceProposalNarrowedInput(
        model,
        rowsRef.current,
        choice,
      );
      return { ...(narrowedInput ? { narrowedInput } : {}), declinedItems };
    },
    [model],
  );

  if (!approval || !model) return null;
  const settledDeclined = approval.status === 'rejected' || approval.status === 'canceled';
  let display: ResourceProposalDisplay;
  if (restored) display = { kind: 'restored' };
  else if (localRun?.kind === 'trashed') {
    display = emptied
      ? { kind: 'emptied', count: emptied.outcomes.filter((outcome) => outcome.status === 'deleted').length, freedBytes: emptied.freedBytes }
      : { kind: 'trashed', result: localRun.result };
  } else if (localRun?.kind === 'stopped') display = { kind: 'stopped', result: localRun.result };
  // Reopen (AGW-8): the declined request stays rejected; the person reviews it again and runs it here.
  else if (reopened && settledDeclined) display = { kind: 'ask', stale: false, checking: check.kind === 'checking' };
  else display = deriveResourceProposalDisplay(approval, model, check, emptied);
  const selectedCount = rows.filter((row) => row.selected).length;
  const stale = display.kind === 'ask' && display.stale;
  const batchId = display.kind === 'trashed' ? display.result.batchId : null;
  const scope = {
    machineId: model.machineId,
    ...(serverId ? { serverId } : {}),
  };
  const approveWithheld = selectedCount === 0 || stale || check.kind !== 'ready';
  const runFromUi = async (keys: ReadonlySet<string> | null): Promise<boolean> => {
    const selectedRows = rowsRef.current.filter((row) => (keys ? keys.has(row.item.key) && row.selectable : row.selected));
    const input = buildResourceProposalNarrowedInput(model, selectedRows.map((row) => ({ ...row, selected: true })));
    if (!input) return false;
    const outcome = await runResourceProposalFromUi(model, input, serverId);
    if (!outcome) return false;
    if (keys && localRunRef.current === null) {
      // A retried item reports beside the original receipt; the receipt's totals stay the real ones.
      setRetried((current) => new Map([...current, ...readRetriedOutcomes(outcome, keys)]));
      // Its own receipt, from that retry's settled result (its own Trash batch, Undo and Empty now).
      if (outcome.kind === 'trashed') setRetryReceipts((current) => [...current, { result: outcome.result, emptied: null, restored: false }]);
      return true;
    }
    setLocalRun(outcome);
    return true;
  };
  const endedKeys = display.kind === 'stopped'
    ? display.result.outcomes.filter((outcome) => outcome.outcome === 'ended').map((outcome) => outcome.ref) : [];
  return {
    model,
    approvedKeys: localRun ? new Set(rows.filter((row) => row.selected).map((row) => row.item.key)) : resourceProposalApprovedKeys(approval, model),
    rows,
    check,
    display,
    selectedCount,
    selectedBytes: resourceProposalSelectedBytes(rows),
    approveWithheld,
    toggle,
    confirmKeep,
    toggleAll,
    selectAllSafe,
    checkAgain,
    decisionOptions,
    reopened: reopened && settledDeclined && !localRun,
    reopen: settledDeclined && !reopened ? () => { setReopened(true); runCheck(true); } : null,
    runFromUi: reopened && settledDeclined && !localRun && !approveWithheld ? () => runFromUi(null) : null,
    retryItem: display.kind === 'trashed' || display.kind === 'stopped'
      ? (key: string) => runFromUi(new Set([key])) : null,
    retried,
    startAgain: model.actionId === 'machines.processes.stop' && endedKeys.length > 0 && serverId
      ? async (key: string) => {
          const started = await startResourceProposalProcessAgain(model.machineId, key, serverId);
          if (started) setStartedAgain((current) => new Set(current).add(key));
          return started;
        }
      : null,
    startedAgain,
    retryReceipts: retryReceipts.map((receipt, index): ResourceProposalRetryReceipt => {
      const update = (patch: Partial<RetryReceiptState>) =>
        setRetryReceipts((current) => current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
      const batch = { ...scope, batchId: receipt.result.batchId };
      const acted = receipt.result.outcomes.filter((outcome) => outcome.status === 'moved' || outcome.status === 'deleted').length;
      return {
        batchId: receipt.result.batchId,
        restored: receipt.restored,
        bar: receipt.emptied
          ? { kind: 'freed', count: receipt.emptied.outcomes.filter((outcome) => outcome.status === 'deleted').length, freedBytes: receipt.emptied.freedBytes }
          : { kind: 'held', batchId: receipt.result.batchId, count: acted, inTrashBytes: receipt.result.inTrashBytes,
            notActed: receipt.result.outcomes.length - acted, emptiesAt: null },
        undo: receipt.emptied || receipt.restored ? null : async () => {
          const result = await restoreMachineStorageTrashViaAction(batch);
          if (result.ok) update({ restored: true });
          return result.ok;
        },
        emptyNow: receipt.emptied || receipt.restored || receipt.result.inTrashBytes === 0 ? null : async () => {
          const result = await emptyMachineStorageTrashViaAction(batch);
          if (result.ok) update({ emptied: result.value });
          return result.ok;
        },
      };
    }),
    emptyNow:
      batchId && display.kind === 'trashed' && display.result.inTrashBytes > 0
        ? async () => {
            const result = await emptyMachineStorageTrashViaAction({
              ...scope,
              batchId,
            });
            if (result.ok) setEmptied(result.value);
            return result.ok;
          }
        : null,
    undo: batchId
      ? async () => {
          const result = await restoreMachineStorageTrashViaAction({
            ...scope,
            batchId,
          });
          if (result.ok) setRestored(true);
          return result.ok;
        }
      : null,
  };
}

type ResourceProposalLocalRun =
  | Readonly<{ kind: 'trashed'; result: PileApplyResultV1 }>
  | Readonly<{ kind: 'stopped'; result: MachineProcessesActionResultV1 }>;

/** The same Action, invoked by the present person from the UI: a new invocation, re-checked by its executor. */
async function runResourceProposalFromUi(
  model: ResourceProposalModel,
  input: Readonly<Record<string, unknown>>,
  serverId: string | null,
): Promise<ResourceProposalLocalRun | null> {
  if (model.kind === 'storage') {
    const result = await moveMachineStorageToTrashViaAction({
      ...(input as MachineStorageTrashMoveInputV1),
      ...(serverId ? { serverId } : {}),
    });
    return result.ok ? { kind: 'trashed', result: result.value } : null;
  }
  if (!serverId) return null;
  const account = await captureLazyActionAccountContext(serverId);
  try {
    const actionId = model.actionId;
    if (actionId === 'machines.storage.trash.move') return null;
    const parsedInput = MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[actionId].safeParse({ ...input, serverId });
    if (!parsedInput.success) return null;
    const outcome = await executeMachineProcessesActionV1(actionId, parsedInput.data, { serverId, expectedAccountId: account.accountId });
    const result = outcome.ok ? readResourceProposalProcessResult(model, outcome.result) : null;
    return result ? { kind: 'stopped', result } : null;
  } finally {
    account.dispose();
  }
}

function readRetriedOutcomes(run: ResourceProposalLocalRun, keys: ReadonlySet<string>): Map<string, ResourceProposalOutcome> {
  const out = new Map<string, ResourceProposalOutcome>();
  if (run.kind === 'trashed') {
    for (const outcome of run.result.outcomes) {
      if (!keys.has(outcome.itemId)) continue;
      out.set(outcome.itemId, { status: outcome.status === 'moved' || outcome.status === 'deleted' ? 'done' : 'skipped', reasonCode: outcome.reason?.code ?? null });
    }
  } else {
    for (const outcome of run.result.outcomes) {
      if (!keys.has(outcome.ref)) continue;
      out.set(outcome.ref, { status: outcome.outcome === 'ended' || outcome.outcome === 'gone_before' ? 'done' : 'skipped', reasonCode: outcome.reasonCode ?? null });
    }
  }
  return out;
}

/** Start again after a stop (AGW-8): the process owner's own Action and its launcher review. */
async function startResourceProposalProcessAgain(machineId: string, ref: string, serverId: string): Promise<boolean> {
  const account = await captureLazyActionAccountContext(serverId);
  try {
    const outcome = await executeMachineProcessesStartAgainV1({ machineId, serverId, ref },
      { serverId, expectedAccountId: account.accountId },
      { runtimeActionExecute: createFrontDoorRuntimeActionExecutor() });
    if (!outcome.processAction.ok) return false;
    const parsed = MachineProcessesStartAgainResultV1Schema.safeParse(outcome.processAction.result);
    return outcome.serviceStartResponse !== undefined
      || (parsed.success && (parsed.data.status === 'started' || parsed.data.status === 'already_wakes_on_next_message'));
  } finally {
    account.dispose();
  }
}

type RetryReceiptState = Readonly<{ result: PileApplyResultV1; emptied: TrashEmptyResultV1 | null; restored: boolean }>;

export type ResourceProposalRetryReceipt = Readonly<{
  batchId: string;
  restored: boolean;
  bar: StoragePileBar;
  undo: (() => Promise<boolean>) | null;
  emptyNow: (() => Promise<boolean>) | null;
}>;
