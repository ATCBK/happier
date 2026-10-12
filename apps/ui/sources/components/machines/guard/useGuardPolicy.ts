import * as React from 'react';
import { mergeMachineGuardPolicyV1, type MachineGuardPolicyPatchV1, type MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';

import type { MachineGuardViewHookResult } from '@/sync/domains/machines/guard/useMachineGuardView';
import type { MachineResourcesPolicyReadOnlyReason } from '@/sync/domains/machines/resources/machineResourcesPolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type GuardRowId = 'memory' | 'level' | 'sustain' | 'cooldown' | 'steps' | 'idle' | 'idleAfter' | 'idleLead'
    | 'terminals' | 'terminalsAfter' | 'terminalsLead' | 'leftBehind' | 'grace' | 'ceiling' | 'ceilingWarn' | 'awake';

/**
 * The Guard's rules as the machine's one resources policy (`guard` section) through
 * `machines.resources.policy.set`: a change shows at once, the machine's answer decides what stays,
 * and a save that does not land returns the row to the truth and says so there. The controls stay
 * where they are while a save is in flight.
 */
export function useGuardPolicy(guard: Pick<MachineGuardViewHookResult, 'settings' | 'settingsPolicy'>): Readonly<{
    policy: MachineGuardPolicyV1 | null;
    editable: boolean;
    readOnlyReason: MachineResourcesPolicyReadOnlyReason;
    failed: ReadonlySet<GuardRowId>;
    save: (row: GuardRowId, patch: MachineGuardPolicyPatchV1) => void;
}> {
    const resources = guard.settings;
    const [pending, setPending] = React.useState<MachineGuardPolicyV1 | null>(null);
    const [failed, setFailed] = React.useState<ReadonlySet<GuardRowId>>(() => new Set());
    // Changes made while an earlier one is still saving compose on top of it; the machine's answers
    // decide what stays once the last one has landed, so the controls never leave their rows meanwhile.
    const pendingNow = React.useRef<MachineGuardPolicyV1 | null>(null);
    const saving = React.useRef(0);
    const truth = guard.settingsPolicy;
    const policy = pending ?? truth;
    const { set } = resources;
    const save = React.useCallback((row: GuardRowId, patch: MachineGuardPolicyPatchV1) => {
        const base = pendingNow.current ?? truth;
        if (!base) return;
        pendingNow.current = mergeMachineGuardPolicyV1(base, patch);
        saving.current += 1;
        setPending(pendingNow.current);
        setFailed(previous => { const next = new Set(previous); next.delete(row); return next; });
        fireAndForget((async () => {
            const result = await set({ guard: patch });
            saving.current -= 1;
            if (saving.current === 0) {
                pendingNow.current = null;
                setPending(null);
            }
            setFailed(previous => { const next = new Set(previous); if (result.saved) next.delete(row); else next.add(row); return next; });
        })(), { tag: 'GuardTab.save' });
    }, [truth, set]);
    return { policy, editable: resources.editable, readOnlyReason: resources.readOnlyReason, failed, save };
}
