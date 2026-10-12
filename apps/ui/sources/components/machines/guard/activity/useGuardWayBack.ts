import * as React from 'react';
import type { MachineGuardActivityRowV1, MachineGuardActivityWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import { Modal } from '@/modal';
import { machineGuardStore } from '@/sync/domains/machines/guard/machineGuardStore';
import { undoMachineGuardActivityViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { t } from '@/text';

import { isGuardRestoration } from './guardActivityPresentation';

/**
 * A receipt's way back. Resume, Start again, Reopen and Undo go through the receipt's own Undo on the
 * machine (it re-runs the captured original Action under that Action's approval); Empty now, Raise
 * ceiling and Review processes run their own Action. Either way the next Guard answer says what changed.
 */
export function useGuardWayBack(input: Readonly<{ serverId: string; machineId: string }>): Readonly<{
    pendingId: string | null;
    run: (entry: MachineGuardActivityRowV1, item: MachineGuardActivityWayBackV1) => void;
}> {
    const { key } = useMachineDaemonReadTarget(input);
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const run = React.useCallback((entry: MachineGuardActivityRowV1, item: MachineGuardActivityWayBackV1) => {
        setPendingId(`${entry.id}:${item.label}`);
        void (async () => {
            let ok = false;
            try {
                if (isGuardRestoration(item)) {
                    ok = (await undoMachineGuardActivityViaAction({ ...key, entryId: entry.id })).ok;
                } else {
                    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
                    const outcome = await createFrontDoorActionExecute()(item.actionId, item.input, {
                        surface: 'ui', ...(key.serverId ? { serverId: key.serverId } : {}),
                        ...(key.expectedAccountId ? { expectedAccountId: key.expectedAccountId } : {}),
                    });
                    ok = outcome.ok;
                }
            } finally {
                setPendingId(null);
                machineGuardStore.refreshMachine(key);
            }
            if (!ok) Modal.alert(t('machineGuard.activity.title'), t('machineGuard.activity.wayBackFailed'));
        })();
    }, [key]);
    return { pendingId, run };
}
