import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executePluginDevLoopAction } from './actions';

const daemon = vi.hoisted(() => ({ request: vi.fn(), ensure: vi.fn(async () => {}) }));
// The daemon control channel is the genuine process boundary. Action admission,
// input parsing and the lifecycle adapter remain real below the public executor.
vi.mock('@/daemon/controlClient', async (original) => ({
  ...await original<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginChange: daemon.request,
}));
vi.mock('@/daemon/ensureDaemon', () => ({ ensureDaemonRunningForSessionCommand: daemon.ensure }));

describe('plugin lifecycle Actions', () => {
  beforeEach(() => {
    daemon.request.mockReset();
    daemon.request.mockResolvedValue({ kind: 'committed', pluginId: 'acme.plugin', desiredGeneration: 'generation-2',
      appliedGeneration: 'generation-2', pendingSurfaces: [] });
  });

  it.each([
    ['plugins.enable', 'enable'],
    ['plugins.disable', 'disable'],
    ['plugins.rollback', 'rollback'],
    ['plugins.trust.forget', 'forgetTrust'],
    ['plugins.update_policy.set', 'setUpdatePolicy'],
    ['plugins.uninstall', 'uninstall'],
  ] as const)('admits %s for UI and preserves the daemon-owned change', async (actionId, kind) => {
    const input = { machineId: 'machine-1', pluginId: 'acme.plugin',
      ...(kind === 'setUpdatePolicy' ? { policy: 'pinned' } : {}) };
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      isActionApprovalRequired: () => false,
      pluginsDevLoopAction: executePluginDevLoopAction,
    });
    const outcome = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(outcome).toMatchObject({ ok: true, result: { ok: true, pluginId: 'acme.plugin', change: { kind: 'committed' } } });
    expect(daemon.request).toHaveBeenCalledWith(expect.objectContaining({ kind, pluginId: 'acme.plugin' }));
    const outputSchema = getActionSpec(actionId).outputSchema;
    if (!outputSchema) throw new Error('Lifecycle Action output schema missing');
    expect(outputSchema.safeParse(outcome.ok ? outcome.result : undefined).success).toBe(true);
  });

  it('does not reach the daemon when lifecycle Actions are Off or awaiting Ask-first approval', async () => {
    const disabled = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionEnabled: () => false, pluginsDevLoopAction: executePluginDevLoopAction });
    expect(await disabled.execute('plugins.disable', { pluginId: 'acme.plugin' }, { surface: 'ui' }))
      .toMatchObject({ ok: false });
    let request: unknown;
    const ask = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => true, pluginsDevLoopAction: executePluginDevLoopAction,
      approvalsCreate: async (args) => { request = args.request; return { artifactId: 'approval-plugin' }; },
    });
    expect(await ask.execute('plugins.disable', { machineId: 'machine-1', pluginId: 'acme.plugin' }, {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home', actionRequestId: 'disable-1',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(request).toMatchObject({ actionId: 'plugins.disable', actionArgs: { machineId: 'machine-1', pluginId: 'acme.plugin' } });
    expect(daemon.request).not.toHaveBeenCalled();
  });
});
