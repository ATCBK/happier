import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import type { ActionExecutorDeps } from './executor/types.js';

function lifecycleDeps(pluginsDevLoopAction: NonNullable<ActionExecutorDeps['pluginsDevLoopAction']>): ActionExecutorDeps {
  // Unused process/network ports fail loudly; the lifecycle port represents
  // the external daemon boundary, not substituted internal domain logic.
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected lifecycle test transport'); };
  return {
    executionRunStart: unavailable, executionRunList: unavailable, executionRunGet: unavailable,
    detachedExecutionRunSend: unavailable, executionRunStop: unavailable, executionRunAction: unavailable,
    executionRunWait: unavailable, sessionOpen: unavailable, sessionFork: unavailable,
    sessionRollback: unavailable, sessionSpawnNew: unavailable, pathsListRecent: unavailable,
    machinesList: unavailable, serversList: unavailable, reviewEnginesList: unavailable,
    agentsBackendsList: unavailable, agentsModelsList: unavailable, sessionSendMessage: unavailable,
    sessionPermissionRespond: unavailable, sessionUserActionAnswer: unavailable,
    sessionModeSet: unavailable, sessionModesList: unavailable, sessionList: unavailable,
    sessionActivityGet: unavailable, sessionRecentMessagesGet: unavailable, resetGlobalVoiceAgent: unavailable,
    daemonMemorySearch: unavailable, daemonMemoryGetWindow: unavailable, daemonMemoryEnsureUpToDate: unavailable,
    pluginsDevLoopAction,
  };
}

describe('plugin lifecycle confirmation policy', () => {
  it('admits an installed-channel update without accepting caller-owned distribution or trust', () => {
    const schema = getActionSpec('plugins.install').inputSchema;
    const input = { machineId: 'machine-1', source: { kind: 'installed', pluginId: 'acme.lifecycle' } };
    expect(schema.safeParse(input).success).toBe(true);
    expect(schema.safeParse({ ...input, source: { ...input.source, path: '/other/channel' } }).success).toBe(false);
    expect(schema.safeParse({ ...input, approved: true }).success).toBe(false);
  });

  for (const id of ['plugins.enable', 'plugins.disable', 'plugins.rollback', 'plugins.update_policy.set', 'plugins.trust.forget']) {
    it(`keeps ${id} automation review waivable independently from own-UI defaults`, async () => {
      const actionId = id as ActionId;
      const spec = getActionSpec(actionId);
      const input = { pluginId: 'acme.lifecycle', ...(id === 'plugins.update_policy.set' ? { policy: 'pinned' } : {}) };
      const settings = ActionsSettingsV1Schema.parse({ v: 1 });
      let effects = 0;
      const executor = createActionExecutor(lifecycleDeps(async () => {
        effects++;
        return { ok: true, kind: id.replaceAll('.', '_'), change: { kind: 'committed' } };
      }));
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveActionApprovalRouting({ actionId, spec, input, settings, context: { surface } }).required).toBe(true);
        expect(await executor.execute(actionId, input, { surface, actionsSettings: settings })).toMatchObject({ ok: false });
        expect(effects).toBe(0);
      }
      const ownUi = { surface: 'ui' as const, authority: 'present_user' as const };
      const destructive = id === 'plugins.trust.forget';
      expect(resolveActionApprovalRouting({ actionId, spec, input, settings, context: ownUi }).required).toBe(destructive);
      for (const surface of ['ui', 'agent', 'mcp'] as const) {
        const waived = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [id]: [surface] } });
        expect(await executor.execute(actionId, input, { surface, actionsSettings: waived })).toMatchObject({ ok: true, result: { change: { kind: 'committed' } } });
      }
      const ask = ActionsSettingsV1Schema.parse({ v: 1, actions: { [id]: { approvalRequiredSurfaces: ['ui'] } } });
      expect(resolveActionApprovalRouting({ actionId, spec, input, settings: ask, context: ownUi }).required).toBe(true);
    });
  }
});
