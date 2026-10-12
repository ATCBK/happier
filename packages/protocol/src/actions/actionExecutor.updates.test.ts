import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('Updates Action parity', () => {
  it('admits only exact managed CLI and current batch selectors', () => {
    for (const [rawId, input] of [
      ['updates.get', {}],
      ['machines.cli.update', { target: { kind: 'local' } }],
      ['machines.cli.update', { target: { kind: 'machine', machineId: 'studio' } }],
      ['updates.check', {}],
      ['updates.batch.start', { groupId: 'machine:studio', itemIds: ['studio:happier-cli'] }],
      ['updates.batch.stop', {}],
    ] as const) {
      const id = ActionIdSchema.parse(rawId);
      const spec = getActionSpec(id);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.inputSchema.parse(input)).toEqual(input);
      expect(spec.inputSchema.safeParse({ ...input, command: 'unreviewed recipe' }).success).toBe(false);
    }
  });

  it('requires canonical UI confirmation for CLI and batch updates', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    for (const rawId of ['machines.cli.update', 'updates.batch.start']) {
      const id = ActionIdSchema.parse(rawId);
      expect(isApprovalRequiredByActionsSettings(id, settings, { surface: 'ui', authority: 'present_user' })).toBe(true);
    }
  });

  it('dispatches the selected current owner and preserves typed no-effect refusal', async () => {
    // The answering app is the system boundary; canonical admission/output validation remain real.
    const deps = { updatesAction: async () => ({ ok: false, errorCode: 'update_target_unavailable', error: 'update_target_unavailable' }) };
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    expect(await executor.execute('machines.cli.update', { target: { kind: 'machine', machineId: 'studio' } }, {
      surface: 'ui', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.cli.update' },
    })).toMatchObject({ ok: false, errorCode: 'update_target_unavailable' });
  });

});
