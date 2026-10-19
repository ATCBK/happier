import { describe, expect, it } from 'vitest';
import { MachineGuardActivityRowV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';

import { describeGuardActivityRow, groupGuardActivityByDay, summarizeGuardActivity } from './guardActivityPresentation';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { t } from '@/text';

describe('Guard Activity presentation data', () => {
    it('keeps reclaimed housekeeping and emptied Trash as decimal disk bytes beside binary freed memory', () => {
        const receipt = (kind: 'housekeeping' | 'stopped_session' | 'trash_emptied', freedBytes: number, undoneAt?: number) => MachineGuardActivityRowV1Schema.parse({
            v: 1, id: kind, at: 1000, kind, rule: kind === 'stopped_session' ? 'idle_sessions' : 'housekeeping',
            subject: kind === 'stopped_session' ? { kind: 'session', sessionId: 'session', title: 'Build' }
                : kind === 'housekeeping' ? { kind: 'housekeeping', logs: 4, recordings: 1, trashEntries: 2 }
                : { kind: 'trash', items: 3 },
            outcome: 'done', attribution: { kind: 'unknown' }, freedBytes, ...(undoneAt === undefined ? {} : { undoneAt }),
        });
        const housekeeping = receipt('housekeeping', 1_000_000_000);
        const memory = receipt('stopped_session', 1024 ** 3);
        const trash = receipt('trash_emptied', 2_000_000_000);
        const entries = [housekeeping, memory, trash, receipt('housekeeping', 9_000_000_000, 2000), receipt('stopped_session', 1024 ** 3, 2000)];
        expect(summarizeGuardActivity(entries).freedBytes).toBe(1024 ** 3);
        expect(groupGuardActivityByDay(entries)[0]?.freedMemoryBytes).toBe(1024 ** 3);
        for (const entry of [housekeeping, trash]) expect(describeGuardActivityRow(entry).figure).toBe(
            t('machineGuard.activity.freed', { amount: formatMachineBytes(entry.freedBytes!, 'storage') }),
        );
        expect(describeGuardActivityRow(memory).figure).toBe(t('machineGuard.activity.freed', { amount: formatMachineBytes(1024 ** 3, 'memory') }));
        expect(describeGuardActivityRow(entries[3]!).figure).toBeNull();
    });
    it.each(['too_many_open_files', 'no_ptys', 'process_limit', 'out_of_memory', 'other'] as const)(
        'preserves the typed %s start failure and next step without diagnostic prose', failureReason => {
            const nextStep = failureReason === 'no_ptys' ? 'close_idle_terminals' : 'review_processes';
            const entry = MachineGuardActivityRowV1Schema.parse({
                v: 1, id: 'failed-resume', at: 1, kind: 'start_failed', rule: 'idle_sessions',
                subject: { kind: 'session', sessionId: 'session', title: 'Build' },
                outcome: 'failed', attribution: { kind: 'unknown' },
                failure: { reason: failureReason }, nextStep,
                note: 'Could not resume: spawn-rejected',
            });

            const model = describeGuardActivityRow(entry);

            expect(model).toMatchObject({
                tone: 'danger',
                startFailure: {
                    reasonKey: `machineGuard.activity.startFailure.${failureReason}`,
                    nextStepKey: `machineGuard.activity.nextStep.${nextStep}`,
                },
            });
            expect(model.reason).toBeNull();
        },
    );

    it('counts under "In Trash" only the items still there, not moves the Trash has since emptied', () => {
        const moved = (id: string, items: number, inTrashBytes: number) => MachineGuardActivityRowV1Schema.parse({
            v: 1, id, at: 1, kind: 'trash_moved', rule: 'approved_proposal',
            subject: { kind: 'trash', items }, outcome: 'done', attribution: { kind: 'unknown' }, inTrashBytes,
        });
        const summary = summarizeGuardActivity([moved('emptied', 6, 0), moved('kept', 2, 4_096)]);

        expect(summary).toMatchObject({ inTrashBytes: 4_096, trashItems: 2 });
        expect(summarizeGuardActivity([moved('emptied', 6, 0)])).toMatchObject({ inTrashBytes: 0, trashItems: 0 });
    });
});
