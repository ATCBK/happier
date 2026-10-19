import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(vi.fn());
});

import { formatResetAtTime } from '@/utils/time/formatResetAtTime';

import { AgentInstallJobRpcError } from './api';
import { presentAgentInstallJobFailure, presentAgentInstallJobRpcFailure } from './presentAgentInstallJobFailure';

describe('agent install failure presentation', () => {
    it('distinguishes unavailable job operations from an unreachable machine without inventing an install outcome', () => {
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('unavailable'))).toMatchObject({
            title: 'agentInstallJob.jobUnavailable', body: 'agentInstallJob.jobUnavailableBody',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('request_failed'))).toMatchObject({
            title: 'agentInstallJob.machineUnreachable', body: 'agentInstallJob.unreachableBody',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('invalid_response'))).toMatchObject({
            title: 'agentInstallJob.failed', body: 'agentInstallJob.failedBody',
        });
        expect(presentAgentInstallJobRpcFailure(new AgentInstallJobRpcError('job_not_found'))).toMatchObject({
            title: 'agentInstallJob.jobMissing', body: 'agentInstallJob.jobMissingBody',
        });
    });

    it('keeps raw vendor diagnostics out of primary copy and offers only an available recovery', () => {
        const failure = { kind: 'failed', code: 'update_not_available', stepId: 'cli', message: 'raw vendor output', guideUrl: 'https://example.com/install' } as const;
        expect(presentAgentInstallJobFailure(failure)).toMatchObject({
            body: 'agentInstallJob.updateBody', recovery: { kind: 'guide', guideUrl: failure.guideUrl },
        });
        expect(presentAgentInstallJobFailure({ ...failure, guideUrl: undefined }).recovery.kind).toBe('chooseAgent');
    });

    it('says the download source is rate-limited and when to retry, in local time rather than the raw reset', () => {
        const resetIso = '2026-10-19T14:20:00.000Z';
        const failure = {
            kind: 'failed', code: 'rate_limited', stepId: 'download',
            message: `GitHub's API rate limit has been reached. Try again after ${resetIso}.`,
        } as const;
        const presented = presentAgentInstallJobFailure(failure);
        expect(presented).toMatchObject({
            code: 'rate_limited', title: 'agentInstallJob.rateLimited',
            recovery: { kind: 'retry', label: 'agentInstallJob.retry' },
        });
        expect(presented.body).toBe(`agentInstallJob.rateLimitedBody(time=${formatResetAtTime(Date.parse(resetIso))})`);
        expect(presented.body).not.toContain(resetIso);
    });

    it('does not invent a retry time when the rate-limit message names none', () => {
        const presented = presentAgentInstallJobFailure({
            kind: 'failed', code: 'rate_limited', stepId: 'download',
            message: 'GitHub\'s API rate limit has been reached. Wait for GitHub to reset it, then try again.',
        });
        expect(presented).toMatchObject({ title: 'agentInstallJob.rateLimited', body: 'agentInstallJob.rateLimitedBodyNoTime' });
    });
});
