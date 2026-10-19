import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));

import { resumeActionOperationHandoff } from './resumeActionOperationHandoff';

describe('resumeActionOperationHandoff', () => {
    beforeEach(() => { machineRpcWithServerScope.mockReset(); });

    it('settles an unanswered handoff read when its request owner cancels', async () => {
        machineRpcWithServerScope.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const controller = new AbortController();
        let result: Awaited<ReturnType<typeof resumeActionOperationHandoff>> | undefined;
        void resumeActionOperationHandoff({ serverId: 'home-a', handoffId: 'handoff-1', sessionId: 'session-1',
            targetMachineId: 'machine-1', signal: controller.signal }).then(value => { result = value; });
        controller.abort();
        await vi.waitFor(() => expect(result).toEqual({ kind: 'failed', message: 'aborted' }));
    });

    it('queries and resumes the projected target through canonical machine RPC methods', async () => {
        machineRpcWithServerScope.mockResolvedValueOnce({
            handoffId: 'handoff-1',
            transitionRevision: 7,
            status: {
                handoffId: 'handoff-1',
                status: 'awaiting_user_resume' as const,
                phase: 'resuming' as const,
                jobId: 'job-1',
                recoveryActions: [],
            },
        }).mockResolvedValueOnce({
            ok: true as const,
            handoffId: 'handoff-1',
            jobId: 'job-1',
            transitionRevision: 8,
            status: {
                handoffId: 'handoff-1',
                status: 'in_progress' as const,
                phase: 'resuming' as const,
                jobId: 'job-1',
                recoveryActions: [],
            },
        });

        await expect(resumeActionOperationHandoff({
            serverId: 'home-a',
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
            createAttemptId: () => 'attempt-1',
        })).resolves.toEqual({ kind: 'requested' });

        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(1, {
            machineId: 'machine-target', serverId: 'home-a', method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET_V3,
            payload: { handoffId: 'handoff-1' },
        });
        expect(machineRpcWithServerScope).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-target', serverId: 'home-a', method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESUME_V3,
            payload: {
                handoffId: 'handoff-1',
                jobId: 'job-1',
                expectedRevision: 7,
                attemptId: 'attempt-1',
            },
        });
    });

    it('does not guess resume material when canonical status is no longer resumable', async () => {
        machineRpcWithServerScope.mockResolvedValue({
                handoffId: 'handoff-1',
                transitionRevision: 8,
                status: {
                    handoffId: 'handoff-1',
                    status: 'completed',
                    phase: 'finalizing',
                    recoveryActions: [],
                },
        });

        await expect(resumeActionOperationHandoff({
            serverId: 'home-a',
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
            createAttemptId: () => 'attempt-1',
        })).resolves.toEqual({ kind: 'not_available' });
        expect(machineRpcWithServerScope).toHaveBeenCalledOnce();
    });

    it('does not issue ambient RPC without exact Home evidence', async () => {
        await expect(resumeActionOperationHandoff({
            serverId: null,
            handoffId: 'handoff-1',
            sessionId: 'session-1',
            targetMachineId: 'machine-target',
        })).resolves.toEqual({ kind: 'not_available' });

        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
});
