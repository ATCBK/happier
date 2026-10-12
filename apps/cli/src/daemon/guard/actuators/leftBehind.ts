import { randomUUID } from 'node:crypto';
import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { MachineProcessesCleanUpResultV1Schema } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { LeftBehindItem } from '../../processes/leftBehind/leftBehindTracker';
import { processOwnerKey, type ProcessOwnerRef } from '../../processes/ownership/types';
import type { HappierProcessRootSource } from '../../processes/roots/listHappierProcessRoots';
import { processRef } from '../../processes/view/processRef';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import type { MachineGuardActivityEntryV1, MachineGuardActivityWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import type { ActivityLog } from '../activityLog';

export type LeftBehindDecision = Readonly<{
  mode: 'ask' | 'automatic'; owner: ProcessOwnerRef; refs: readonly string[]; signature: string;
}>;
export type LeftBehindPlan = Readonly<{ due: readonly LeftBehindDecision[]; nextAt?: number }>;
export type LeftBehindRestoration = Readonly<{
  attribution: MachineGuardActivityEntryV1['attribution']; wayBack: readonly MachineGuardActivityWayBackV1[];
}>;
export type LeftBehindActionRequest = Readonly<{
  mode: 'ask' | 'automatic'; sessionId?: string; refs: readonly string[]; signal?: AbortSignal;
}>;
export type LeftBehindActuatorInput = Readonly<{
  readPolicy(): MachineGuardPolicyV1['leftBehind'];
  confirmed(): readonly LeftBehindItem[];
  readRestoration(owner: ProcessOwnerRef): LeftBehindRestoration | null;
  executeAction(request: LeftBehindActionRequest): Promise<ActionExecuteResult>;
  activity: Pick<ActivityLog, 'append'>;
  nowMs?: () => number;
}>;
export type LeftBehindExecutionResult = Readonly<
  { status: 'requested'; artifactId: string } | { status: 'already_requested' } |
  { status: 'cleaned'; ended: number; skipped: number } |
  { status: 'stale' | 'unsupported' } | { status: 'failed'; reason: string }
>;

export function readLeftBehindRestoration(input: Readonly<{
  owner: ProcessOwnerRef; endedRoots: Iterable<HappierProcessRootSource>; machineId: string;
}>): LeftBehindRestoration | null {
  const root = [...input.endedRoots].find(item => processOwnerKey(item.owner) === processOwnerKey(input.owner));
  if (!root?.requesterWorkAttributionV1 || !root.start) return null;
  return { attribution: root.requesterWorkAttributionV1,
    wayBack: [{ label: 'start_again', actionId: 'machines.processes.startAgain',
      input: { machineId: input.machineId, ref: processRef(root.pid, root.start) } }] };
}

/** Scheduling only; plan 30 owns both confirmation and execution-time identity admission. */
export function planLeftBehind(input: Readonly<{
  policy: MachineGuardPolicyV1['leftBehind']; confirmed: readonly LeftBehindItem[]; now: number;
}>): LeftBehindPlan {
  if (input.policy.mode === 'off') return { due: [] };
  const mode = input.policy.mode;
  const groups = new Map<string, { owner: ProcessOwnerRef; refs: Set<string> }>();
  let nextAt: number | undefined;
  for (const item of input.confirmed) {
    const at = item.confirmedAtMs + input.policy.graceMs;
    if (at > input.now) { nextAt = nextAt === undefined ? at : Math.min(nextAt, at); continue; }
    const key = processOwnerKey(item.owner);
    const group = groups.get(key) ?? { owner: item.owner, refs: new Set<string>() };
    group.refs.add(item.ref); groups.set(key, group);
  }
  const due = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]): LeftBehindDecision => {
    const refs = [...group.refs].sort();
    return { mode, owner: group.owner, refs, signature: JSON.stringify([mode, key, refs]) };
  });
  return { due, ...(nextAt === undefined ? {} : { nextAt }) };
}

/** The existing Action ingress owns approval and effect; this adapter owns the Guard receipt. */
export function createLeftBehindActuator(input: LeftBehindActuatorInput) {
  const now = input.nowMs ?? Date.now;
  // Successful Ask receipts only, for this daemon lifetime. Confirmation and cleanup intent remain plan 30's facts.
  const requested = new Map<string, LeftBehindDecision>();
  // An incumbent policy/inventory/minute edge admits retry, never the loop's own completion edge.
  const failed = new Set<string>();
  const plan = () => {
    const policy = input.readPolicy();
    const confirmed = input.confirmed();
    const remaining = policy.mode === 'ask' ? confirmed.filter(item => ![...requested.values()].some(receipt =>
      processOwnerKey(receipt.owner) === processOwnerKey(item.owner) && receipt.refs.includes(item.ref))) : confirmed;
    const planned = planLeftBehind({ policy, confirmed: remaining, now: now() });
    return { ...planned, due: planned.due.filter(item => !failed.has(item.signature)) };
  };
  return {
    plan,
    invalidateFailures: () => failed.clear(),
    async execute(decision: LeftBehindDecision, signal: AbortSignal): Promise<LeftBehindExecutionResult> {
      if (signal.aborted) return { status: 'failed', reason: 'cancelled' };
      if (input.readPolicy().mode === 'ask' && decision.mode === 'ask' && requested.has(decision.signature)) {
        return { status: 'already_requested' };
      }
      const current = plan().due.find(item => item.signature === decision.signature);
      if (!current) return { status: 'stale' };
      const restoration = input.readRestoration(current.owner);
      if (!restoration?.wayBack.some(item => item.label === 'start_again')) {
        await input.activity.append({ v: 1, id: randomUUID(), at: now(),
          kind: 'stop_failed', rule: 'left_behind', outcome: 'failed', subject: { kind: 'processes', count: 0 },
          note: 'Recovery information is unavailable; nothing was cleaned up.',
          attribution: restoration?.attribution ?? { kind: 'unknown' } });
        failed.add(current.signature);
        return { status: 'unsupported' };
      }
      const appendFailure = async (reason: string) => {
        failed.add(current.signature);
        if (current.mode === 'automatic') await input.activity.append({ v: 1, id: randomUUID(), at: now(),
          kind: 'stop_failed', rule: 'left_behind', outcome: 'failed', subject: { kind: 'processes', count: 0 },
          note: reason, attribution: restoration.attribution, wayBack: [...restoration.wayBack] });
        return { status: 'failed' as const, reason };
      };
      let result: ActionExecuteResult;
      try {
        result = await input.executeAction({ mode: current.mode, refs: current.refs, signal,
          ...('sessionId' in current.owner && current.owner.sessionId ? { sessionId: current.owner.sessionId } : {}) });
      } catch { return appendFailure(signal.aborted ? 'cancelled' : 'action_failed'); }
      if (!result.ok) return appendFailure(result.errorCode);
      if (current.mode === 'ask') {
        // This is the incumbent approvalsCreate receipt, not the deferred-effect Action result.
        const receipt = result.result;
        if (!receipt || typeof receipt !== 'object' || !('artifactId' in receipt)
          || typeof receipt.artifactId !== 'string' || !receipt.artifactId.trim()) return appendFailure('invalid_action_output');
        requested.set(current.signature, current);
        return { status: 'requested', artifactId: receipt.artifactId };
      }
      const parsed = MachineProcessesCleanUpResultV1Schema.safeParse(result.result);
      if (!parsed.success) return appendFailure('invalid_action_output');
      const { ended, skipped } = parsed.data;
      const actualRefs = [...ended, ...skipped].map(item => item.ref);
      const selected = new Set(current.refs);
      // The canonical approval owner may narrow the exact set before cleanup.
      if (new Set(actualRefs).size !== actualRefs.length || actualRefs.some(ref => !selected.has(ref))) {
        return appendFailure('invalid_action_output');
      }
      if (!ended.length) failed.add(current.signature);
      await input.activity.append({ v: 1, id: randomUUID(), at: now(), rule: 'left_behind',
        kind: ended.length ? 'stopped_left_behind' : 'stop_failed', outcome: ended.length ? 'done' : 'failed',
        subject: { kind: 'processes', count: ended.length }, freedBytes: ended.reduce((sum, item) => sum + item.freedBytes, 0),
        ...(skipped.length ? { note: skipped.map(item => item.reason).join(', ') } : {}),
        attribution: restoration.attribution, wayBack: [...restoration.wayBack] });
      return { status: 'cleaned', ended: ended.length, skipped: skipped.length };
    },
  };
}
