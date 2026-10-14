import { describe, expect, it } from 'vitest';
import type { MachineGuardLadderV1 } from '@happier-dev/protocol/machines/guard/guardViewV1';
import { MachineGuardActivityListV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';
import { PileApplyResultV1Schema } from '@happier-dev/protocol/storage/storageV1';

import { buildResourceProposalNarrowedInput, describeResourceProposalRows, deriveResourceProposalDisplay, initialResourceProposalSelection, resourceProposalApprovedKeys, resolveResourceProposalOutcomes, selectGuardKeptForProposal, deriveResourceProposalTrashReceipt, resourceProposalDisplayWithTrashReceipt } from './resourceProposalPresentation';
import { readResourceProposalApproval } from './readResourceProposalApproval';
import { getActionSpec, type ApprovalRequest } from '@happier-dev/protocol';

type Excluded = MachineGuardLadderV1['excluded'][number];
const kept = (ref: string, processRef: string, reason: Excluded['reason'] = 'working'): Excluded => ({
    ref, processRef, kind: 'session', label: `Session ${ref}`, reason, footprintBytes: 1,
});

describe('correlated Trash receipts', () => {
    it('adds later measured emptying to settled partial emptyAfter without requiring expired original Activity', () => {
        const result = PileApplyResultV1Schema.parse({ batchId: 'batch', mode: 'trash', inTrashBytes: 2, freedBytes: 8,
            outcomes: [{ itemId: 'first', status: 'moved' }, { itemId: 'second', status: 'moved' }], trashEntryIds: ['remaining'] });
        const activity = MachineGuardActivityListV1Schema.parse({ entries: [{ v: 1, id: 'remaining-trash_emptied', at: 1,
            kind: 'trash_emptied', rule: 'approved_proposal', outcome: 'done', freedBytes: 2, attribution: { kind: 'unknown' } }],
            counts: { stopped: 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: 2 });
        const receipt = deriveResourceProposalTrashReceipt(result, [], activity.entries);
        expect(resourceProposalDisplayWithTrashReceipt(result, receipt)).toEqual({ kind: 'emptied', count: 2, freedBytes: 10 });
        expect(deriveResourceProposalTrashReceipt(result, [], [])).toMatchObject({ deletedCount: 1, unknownCount: 1, freedBytes: 8 });
    });
});

describe('selectGuardKeptForProposal', () => {
    it('joins the planner’s kept rows to the proposal by census process identity, so nothing is both proposed and kept', () => {
        // The planner's own row ref differs from the census ref; only the process identity joins them.
        const excluded = [kept('session:30:1:', 'MzA6MTo'), kept('session:31:1:', 'MzE6MTo', 'waiting_for_you')];
        const shown = selectGuardKeptForProposal(excluded, new Set(['MzA6MTo']));
        expect(shown.map((entry) => entry.processRef)).toEqual(['MzE6MTo']);
    });
});

describe('process set proposals', () => {
    it.each(['machines.processes.kill', 'machines.processes.leftBehind.cleanUp'] as const)('checks, narrows and settles %s through the shared proposal owner', (actionId) => {
        const actionArgs = actionId === 'machines.processes.kill'
            ? { machineId: 'machine-1', targets: ['process-1', 'process-2'].map(ref => ({ ref, expect: { level: 'proven' } })), tree: true }
            : { machineId: 'machine-1', refs: ['process-1', 'process-2'] };
        const model = readResourceProposalApproval({ actionId, actionArgs });
        expect(model).not.toBeNull();
        if (!model) throw new Error('Missing proposal');
        const check = { kind: 'ready' as const, acknowledged: true, checkedAt: 1, facts: new Map(model.items.map(item => [item.key, {
            key: item.key, status: 'present' as const, verdict: 'safe' as const, reason: null,
            expect: { level: actionId === 'machines.processes.kill' ? 'proven' : 'left_behind' }, bytes: 100,
            onDiskBytes: null, loses: [], changed: false,
        }])) };
        const rows = describeResourceProposalRows(model, check, new Set(['process-2']), new Set());
        const narrowed = buildResourceProposalNarrowedInput(model, rows);
        const admitted = getActionSpec(actionId).approvalNarrowing?.narrow(actionArgs, narrowed);
        expect(admitted).toEqual(actionId === 'machines.processes.kill'
            ? { ...actionArgs, targets: [{ ref: 'process-2', expect: { level: 'proven' } }] }
            : { machineId: 'machine-1', refs: ['process-2'] });
        const approval = { v: 2, actionId, actionArgs, status: 'executed', decision: { kind: 'approve', narrowedInput: narrowed },
            execution: { result: actionId === 'machines.processes.kill'
                ? { status: 'ended', outcomes: [{ ref: 'process-2', outcome: 'ended', freedBytes: 100 }] }
                : { ended: [{ ref: 'process-2', freedBytes: 100 }], skipped: [{ ref: 'process-1', reason: 'owner_returned' }] } } } as ApprovalRequest;
        const approved = resourceProposalApprovedKeys(approval, model);
        expect([...approved]).toEqual(['process-2']);
        const display = deriveResourceProposalDisplay(approval, model, check);
        expect(display.kind).toBe('stopped');
        expect(resolveResourceProposalOutcomes(display, approved)?.get('process-2')).toEqual({ status: 'done', reasonCode: null });
        if (actionId === 'machines.processes.leftBehind.cleanUp') {
            expect(resolveResourceProposalOutcomes(display, approved)?.get('process-1')).toEqual({ status: 'skipped', reasonCode: 'owner_returned' });
            expect([...initialResourceProposalSelection(model)]).toEqual(['process-1', 'process-2']);
        }
    });
});
