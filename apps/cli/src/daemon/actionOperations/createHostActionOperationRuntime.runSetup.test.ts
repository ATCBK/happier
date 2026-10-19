import { expect, it } from 'vitest';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { createExecutionRunProjectSetup, createExecutionRunProjectSetupOperationOwner } from '@/agent/runtime/bridges/executionRun/executionRunProjectSetup';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

const scope = { accountId: 'requester', machineId: 'machine' };
const workspace = { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' };
const details = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
  reviewedEffectDigest: 'current', reviewedEffect: { commands: ['setup'] } };

function fixture(runId: string) {
  const runs = new Map<string, ExecutionRunState>();
  const controller = new AbortController();
  const listeners = new Set<(id: string) => void>();
  const publish = () => { for (const listener of listeners) listener(runId); };
  const setup = createExecutionRunProjectSetup({ runId, scope, signal: controller.signal, readRun: () => runs.get(runId), publish });
  runs.set(runId, { runId, callId: `${runId}-call`, sidechainId: `${runId}-side`, sessionId: null, depth: 0,
    intent: 'delegate', backendId: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Work',
    permissionMode: 'default', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    status: 'running', startedAtMs: Date.now(), projectSetup: setup });
  setup.context.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'home',
    machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' } });
  const owner = createExecutionRunProjectSetupOperationOwner({ runs,
    async stop(id) { controller.abort(); const run = runs.get(id); if (run) runs.set(id, { ...run, status: 'cancelled', finishedAtMs: Date.now() }); publish(); return { ok: true }; },
    async waitForChange(id, signal) {
      signal?.throwIfAborted();
      await new Promise<void>(resolve => { const next = (changed: string) => { if (changed === id) { listeners.delete(next); resolve(); } }; listeners.add(next); });
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  return { owner, setup, controller };
}

it('routes a retained Run controller review through the installed operation reader and original decision owner', async () => {
  const f = fixture('original-run');
  const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester' });
  const detach = runtime.attachOwner(f.owner);
  let digest = 'current';
  const waiting = f.setup.context.operationReview!.waitForResume(details, { review: async decision =>
    decision?.reviewedEffectDigest === digest ? null : { ...details, reviewedEffectDigest: digest } });
  void waiting.catch(() => undefined);
  try {
    digest = 'remeasured';
    expect(await runtime.handlers.getV2({ operationId: 'original-run', refreshSetupReview: true })).toMatchObject({ kind: 'found',
      operation: { actionId: 'execution.run.start', operationId: 'original-run', setupReview: { reviewedEffectDigest: digest } } });
    expect(await runtime.decideSetupReview(scope, 'original-run', workspace, 'setup', { reviewedEffectDigest: digest, skipForInvocation: false }))
      .toMatchObject({ operationId: 'original-run' });
    await waiting;
    expect(await runtime.handlers.getV2({ operationId: 'original-run' })).not.toHaveProperty('operation.setupReview');
    expect(runtime.store.list(scope).items).toHaveLength(1);
  } finally { f.controller.abort(); detach(); await waiting.catch(() => undefined); }
});

it('keeps two real Run owner projections attached and detaches only the requested owner', async () => {
  const first = fixture('first-run');
  const second = fixture('second-run');
  const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester' });
  const detachFirst = runtime.attachOwner(first.owner);
  let detachSecond: (() => void) | undefined;
  try {
    detachSecond = runtime.attachOwner(second.owner);
    expect((await runtime.handlers.listV2({})).items.map(item => item.operationId).sort()).toEqual(['first-run', 'second-run']);
    detachFirst();
    expect((await runtime.handlers.listV2({})).items.map(item => item.operationId)).toEqual(['second-run']);
  } finally { detachSecond?.(); first.controller.abort(); second.controller.abort(); }
});
