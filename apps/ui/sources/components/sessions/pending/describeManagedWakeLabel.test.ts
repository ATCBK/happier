import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/sessions/agentInput/components/AgentInputContentPopover', () => ({ AgentInputContentPopover: () => null }));

import { describeManagedWakeLabel } from './ManagedWakePopover';
import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';
import { t } from '@/text';

const names = { controllerName: 'Studio Mac', machineName: 'build-vm', homeName: 'Leeroy’s Home', agentName: 'Codex' };
const failed = (failureCode: ManagedWakeProjection['failureCode'], ready = false): ManagedWakeProjection => ({
    kind: 'agentStartFailed', failureCode, inputCustody: 'queued', canWithdraw: true,
    canRetryAgentStart: ready, canRequestWake: !ready, canResumeRuntime: false,
});

describe('describeManagedWakeLabel', () => {
    it('says which start failed: compute causes never blame the Agent, and each cause reads differently', () => {
        const compute = (['managed_start_refused', 'managed_start_denied', 'managed_start_expired', 'managed_start_failed'] as const)
            .map(code => describeManagedWakeLabel(failed(code), names));
        for (const label of compute) {
            expect(label).toContain('build-vm');
            expect(label).not.toContain('Codex');
        }
        expect(new Set(compute).size).toBe(4);
        // An Agent failure names the Agent, whether or not the machine is awake now.
        expect(describeManagedWakeLabel(failed('runtime_start_failed', true), names)).toContain('Codex');
        expect(describeManagedWakeLabel(failed('runtime_start_failed', false), names)).toContain('Codex');
    });

    it('never reads a bare "Status unknown" for queued input', () => {
        const unknown: ManagedWakeProjection = { kind: 'unknown', inputCustody: 'queued', canWithdraw: true,
            canRetryAgentStart: false, canRequestWake: false, canResumeRuntime: false };
        const label = describeManagedWakeLabel(unknown, names);
        expect(label).not.toBe(t('status.unknown'));
        expect(label).toContain('build-vm');
    });
});
