import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

describe('Sharing row summary', () => {
    it('reports who shares a machine with you, and says nothing when nothing is known (plan 10 MPG-10: no purpose line)', async () => {
        const { describeMachineSharingSummary } = await import('./machineThisMachineSummaries');
        expect(describeMachineSharingSummary({ isShared: true, access: { custodian: { displayName: 'Ben' } } })).toContain('sharedByOwner');
        expect(describeMachineSharingSummary({ isShared: true, access: null })).toContain('sharedWithYou');
        expect(describeMachineSharingSummary({})).toBeUndefined();
    });

    it('gives a cold row its title alone: no summary for Agents and Doctor until their caches hold state', async () => {
        const { describeMachineAgentsReady, describeMachineDoctorSummary } = await import('./machineThisMachineSummaries');
        expect(describeMachineAgentsReady([])).toBeNull();
        expect(describeMachineDoctorSummary(null)).toBeUndefined();
        expect(describeMachineDoctorSummary({ cachedAt: 1_700_000_000_000 })).toContain('doctorChecked');
    });
});
