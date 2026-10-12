import type { MachineResourceReasonV1 } from '../resources/machineResourceSummaryV1.js';
import type { MachineVitalsNotificationV1 } from '../../activity/webhookPayload.js';

export type MachineVitalsNextStepV1 = 'review_processes' | 'turn_on_guard' | 'free_up_space';

export function resolveMachineVitalsNextStepsV1(reason: MachineResourceReasonV1 | Pick<MachineVitalsNotificationV1, 'kind'>, options: Readonly<{ guardEnabled: boolean }>): MachineVitalsNextStepV1[] {
    const kind = reason.kind;
    switch (kind) {
        case 'memory_pressure': return options.guardEnabled ? ['review_processes'] : ['review_processes', 'turn_on_guard'];
        case 'disk_full': case 'disk_nearly_full': return ['free_up_space'];
        case 'cpu_busy': case 'limit_reached': case 'guard_out_of_steps': return ['review_processes'];
    }
}
