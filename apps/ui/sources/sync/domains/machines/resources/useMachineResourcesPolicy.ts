import * as React from 'react';
import { MachineResourcesPolicyMutationResultV1Schema, type MachineResourcesPolicyGetResultV1, type MachineResourcesPolicyPatchV1, type MachineResourcesPolicyV1, type MachineResourcesPolicyMutationResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readSyncedMachineResourcesPolicy, readMachineResourcesPolicyReadOnlyReason, type MachineResourcesPolicyReadOnlyReason } from './machineResourcesPolicy';
import type { MachineResourceKey } from './machineRpc';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type MachineResourcesPolicySetResult = Readonly<{
    saved: boolean;
    status: MachineResourcesPolicyMutationResultV1['status'] | 'failed' | 'read_only';
    policy: MachineResourcesPolicyV1 | null;
    revision: number | null;
    reason?: string;
}>;

type PolicyReceipt = Readonly<{ key: string; policy: MachineResourcesPolicyV1; revision: number }>;
type PolicyView = Readonly<{ snapshot: MachineResourcesPolicyGetResultV1; readOnlyReason: MachineResourcesPolicyReadOnlyReason; key: string }>;
export type MachineResourcesPolicyState = Readonly<{
    status: MachineResourcesPolicyGetResultV1['status'];
    policy: MachineResourcesPolicyV1 | null;
    revision: number | null;
    editable: boolean;
    readOnlyReason: MachineResourcesPolicyReadOnlyReason;
    set: (patch: MachineResourcesPolicyPatchV1) => Promise<MachineResourcesPolicySetResult>;
}>;

function readView(state: ReturnType<typeof storage.getState>, serverId: string, machineId: string, scope: ServerAccountScope | null): PolicyView {
    const machine = resolveServerScopedMachine(state, serverId, machineId);
    return { snapshot: readSyncedMachineResourcesPolicy(machine), readOnlyReason: readMachineResourcesPolicyReadOnlyReason(machine, scope),
        key: JSON.stringify([serverId, machineId, scope?.accountId ?? null]) };
}

function withReceipt(view: PolicyView, receipt: PolicyReceipt | null) {
    if (view.snapshot.status !== 'ready') return { policy: null, revision: null };
    if (receipt?.key === view.key && receipt.revision > view.snapshot.revision) return { policy: receipt.policy, revision: receipt.revision };
    return { policy: view.snapshot.policy, revision: view.snapshot.revision };
}

export function useMachineResourcesPolicy(input: MachineResourceKey): MachineResourcesPolicyState {
    const active = useActiveServerSnapshot(!input.serverId);
    const serverId = input.serverId?.trim() || active.serverId;
    const machineId = input.machineId;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const reachabilityRevision = useMachineReachabilityRevision();
    const signature = storage(React.useCallback((state: ReturnType<typeof storage.getState>) => {
        return JSON.stringify(readView(state, serverId, machineId, scope));
    }, [serverId, machineId, scope, reachabilityRevision]));
    const view = React.useMemo(() => JSON.parse(signature) as PolicyView, [signature]);
    const [receipt, setReceipt] = React.useState<PolicyReceipt | null>(null);
    const receiptRef = React.useRef(receipt);
    const mutationTail = React.useRef<Promise<void>>(Promise.resolve());
    const currentKey = React.useRef(view.key);
    currentKey.current = view.key;
    const truth = withReceipt(view, receipt);
    const set = React.useCallback((patch: MachineResourcesPolicyPatchV1): Promise<MachineResourcesPolicySetResult> => {
        const intentKey = readView(storage.getState(), serverId, machineId, scope).key;
        const account = captureActiveServerAccountScopeCurrentness();
        // Serialize this machine's local intents, not CAS conflicts. Each dispatch reads the latest
        // accepted receipt/synced revision; a refused patch is returned to its row without retrying it.
        const mutation = mutationTail.current.then(async (): Promise<MachineResourcesPolicySetResult> => {
            const before = readView(storage.getState(), serverId, machineId, scope);
            const initial = withReceipt(before, receiptRef.current);
            if (!account.isCurrent() || (binding && !binding.isCurrent()) || before.key !== intentKey || currentKey.current !== intentKey) {
                return { saved: false, status: 'failed', policy: null, revision: null, reason: 'account_scope_changed' };
            }
            if (before.snapshot.status !== 'ready' || before.readOnlyReason || initial.revision === null) {
                return { saved: false, status: 'read_only', ...initial, reason: before.readOnlyReason ?? before.snapshot.status };
            }
            const failed = (reason: string): MachineResourcesPolicySetResult => {
                const after = readView(storage.getState(), serverId, machineId, scope);
                if (!account.isCurrent() || (binding && !binding.isCurrent()) || after.key !== intentKey || currentKey.current !== intentKey) {
                    return { saved: false, status: 'failed', policy: null, revision: null, reason: 'account_scope_changed' };
                }
                return { saved: false, status: 'failed', ...withReceipt(after, receiptRef.current), reason };
            };
            try {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                if (!account.isCurrent() || !binding?.isCurrent() || currentKey.current !== intentKey) {
                    return failed('account_scope_changed');
                }
                const result = await createDefaultActionExecutor().execute('machines.resources.policy.set', { serverId, machineId, expectedRevision: initial.revision, patch }, { surface: 'ui', serverId });
                if (!result.ok) return failed(result.errorCode ?? 'action_failed');
                const parsed = MachineResourcesPolicyMutationResultV1Schema.safeParse(result.result);
                if (!parsed.success) return failed('invalid_policy_result');
                const mutation = parsed.data;
                const after = readView(storage.getState(), serverId, machineId, scope);
                if (!account.isCurrent() || !binding?.isCurrent() || after.key !== before.key || currentKey.current !== before.key) {
                    return { saved: false, status: 'failed', policy: null, revision: null, reason: 'account_scope_changed' };
                }
                if ('policy' in mutation && after.snapshot.status === 'ready') {
                    const current = withReceipt(after, receiptRef.current);
                    if (current.revision === null || mutation.revision >= current.revision) {
                        // A daemon receipt proves only this field, not the rest of Machine.metadata.
                        const next = { key: before.key, policy: mutation.policy, revision: mutation.revision };
                        receiptRef.current = next;
                        setReceipt(next);
                    }
                }
                return { saved: mutation.status === 'applied' || mutation.status === 'unchanged', status: mutation.status,
                    ...withReceipt(after, receiptRef.current), ...('reason' in mutation ? { reason: mutation.reason } : {}) };
            } catch {
                return failed('action_failed');
            }
        });
        mutationTail.current = mutation.then(() => {}, () => {});
        return mutation;
    }, [serverId, machineId, binding, scope]);
    return React.useMemo(() => ({ status: view.snapshot.status, ...truth, editable: view.snapshot.status === 'ready' && !view.readOnlyReason,
        readOnlyReason: view.readOnlyReason, set }), [view, truth.policy, truth.revision, set]);
}
