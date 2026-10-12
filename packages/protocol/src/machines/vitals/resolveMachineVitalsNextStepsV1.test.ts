import { expect, it } from 'vitest';
import { resolveMachineVitalsNextStepsV1 } from './resolveMachineVitalsNextStepsV1.js';
import type { MachineResourceReasonV1 } from '../resources/machineResourceSummaryV1.js';

it('offers the same ordered next steps for every resource surface', () => {
    const memory: MachineResourceReasonV1 = { key: 'memory', level: 'needs_you', since: 0, metric: 'memory', kind: 'memory_pressure', pressure: 'critical', swapping: true };
    expect(resolveMachineVitalsNextStepsV1(memory, { guardEnabled: false })).toEqual(['review_processes', 'turn_on_guard']);
    expect(resolveMachineVitalsNextStepsV1(memory, { guardEnabled: true })).toEqual(['review_processes']);
    expect(resolveMachineVitalsNextStepsV1({ key: 'disk:data', level: 'look', since: 0, metric: 'disk', kind: 'disk_nearly_full', volumeId: 'data', volumeLabel: 'Data' }, { guardEnabled: false })).toEqual(['free_up_space']);
    expect(resolveMachineVitalsNextStepsV1({ key: 'limit:ptys', level: 'needs_you', since: 0, metric: 'limits', kind: 'limit_reached', limit: 'ptys', used: 10, max: 10 }, { guardEnabled: false })).toEqual(['review_processes']);
});

it('offers process review when Guard has exhausted its steps', () => {
    const reason: MachineResourceReasonV1 = { key: 'guard:out_of_steps', kind: 'guard_out_of_steps', level: 'needs_you', since: 0, metric: 'memory', nextStep: 'review_processes' };
    expect(resolveMachineVitalsNextStepsV1(reason, { guardEnabled: true })).toEqual(['review_processes']);
});

it('offers CPU process review without inventing a machine attention reason', () => {
    expect(resolveMachineVitalsNextStepsV1({ kind: 'cpu_busy' }, { guardEnabled: false })).toEqual(['review_processes']);
});
