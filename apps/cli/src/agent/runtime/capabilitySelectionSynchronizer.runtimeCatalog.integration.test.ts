import { describe, expect, it, vi } from 'vitest';
import { withAdmittedSessionRun } from './bridges/executionRun/testkit/admittedSessionRun';
import { createCapabilitySelectionSynchronizer } from './capabilitySelectionSynchronizer';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ExecutionRunListResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

describe('capability refresh during real Run admission', () => {
  it('waits for Run creation custody to settle and retains the admitted Run', async () => {
    let armed = false;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    await withAdmittedSessionRun({
      beforeRunReportPreferencesRead: async () => { if (armed) { entered(); await response; } },
      async run({ rpc, start, session }) {
        armed = true;
        const creating = start();
        await Promise.race([reading, creating.then(() => { throw new Error('Run admission did not reach the held Home read'); })]);
        let metadata = createTestMetadata();
        let enabled = true;
        const context = { machineId: 'admitted-machine', machinePlatform: 'posix' as const,
          directory: '/repo', projectKey: null, agentId: 'fixture' };
        const skillRules = () => [{ id: 'rule', skillId: 'library', target: { t: 'allMachines' as const },
          enabled, createdAt: 1, updatedAt: enabled ? 1 : 2 }];
        const restart = vi.fn(async () => {
          const { runs } = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
            { verifiedPeerAuthority: 'present_user' }));
          expect(runs).toHaveLength(1);
          return { ok: true as const, status: 'restarted' as const, sessionId: session.sessionId };
        });
        let observingIdle!: () => void;
        const waitingForIdle = new Promise<void>(resolve => { observingIdle = resolve; });
        const idle = (signal: AbortSignal) => {
          observingIdle();
          return rpc.waitForIdle(signal, [SESSION_RPC_METHODS.EXECUTION_RUN_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START]);
        };
        const sync = createCapabilitySelectionSynchronizer({
          session: { sessionId: session.sessionId, getMetadataSnapshot: () => metadata,
            updateMetadataAsCurrentPublisher: async update => { metadata = update(metadata); } },
          agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
          isStarted: () => true, isSettled: () => true, waitForIdle: idle, requestRestart: restart,
          initialSkillRules: { context, rules: skillRules() },
          readSkillRules: () => ({ context, rules: skillRules() }),
        });
        enabled = false;
        const applying = sync.flushAfterSettledTurn();
        try {
          await Promise.race([waitingForIdle, applying]);
          expect(restart).not.toHaveBeenCalled();
          const before = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
            { verifiedPeerAuthority: 'present_user' }));
          expect(before.runs).toEqual([]);
          release();
          const admitted = await creating;
          await applying;
          expect(restart).toHaveBeenCalledTimes(1);
          const after = ExecutionRunListResponseSchema.parse(await rpc.invokeLocal(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {},
            { verifiedPeerAuthority: 'present_user' }));
          expect(after.runs.map(run => run.runId)).toEqual([admitted.runId]);
        } finally { release(); await creating; await sync.dispose(); await applying; }
      },
    });
  });
});
