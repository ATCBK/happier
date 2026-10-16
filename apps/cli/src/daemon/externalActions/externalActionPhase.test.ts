import { expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { refuseExternalActionPhase } from './externalActionPhase';
import { executeExternalAction } from './executeExternalAction';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';

it.each(['session.stop', 'session.status.get'])('traces %s admission and real executor phases without caller content', async actionId => {
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const rootRequestId = '70cc64d3-0386-4914-b7d8-713b7879e99f';
  try {
    const execution = await executeExternalAction({ actionId,
      envelope: { v: 1, requestId: rootRequestId, input: { private: 'private-input-marker' } },
      principal: { authority: 'present_user' }, currentMachineId: 'machine-1',
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'private-token-marker', encryption: null } }),
      executor: createCliActionExecutor({ token: 'private-token-marker', sessionId: '', mode: 'plain', ctx: null }),
    });
    expect(execution).toMatchObject({ kind: 'response' });
    const stages = log.mock.calls.filter(([message]) => message === '[external-action-stage]');
    expect(stages).toEqual(expect.arrayContaining([
      ['[external-action-stage]', { actionId, rootRequestId, stage: 'target_resolution.begin' }],
      ['[external-action-stage]', expect.objectContaining({ actionId, rootRequestId,
        stage: 'action_execution.phase', phase: 'cli_context', elapsedMs: expect.any(Number) })],
    ]));
    expect(JSON.stringify(stages)).not.toContain('private-');
  } finally { log.mockRestore(); }
});

it('does not disclose a changing Error name through private diagnostics', () => {
  // The local file sink is an OS boundary; diagnostic classification stays real.
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
  const error = new TypeError('details must remain private');
  let reads = 0;
  Object.defineProperty(error, 'name', { get: () => ++reads === 1 ? 'ZodError' : 'private-details' });
  try {
    const result = refuseExternalActionPhase('requester_settings', 'machine', error);
    expect(result).toEqual({ ok: false, phase: 'requester_settings', errorClass: 'ZodError',
      message: 'External Action phase threw (details redacted)' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-details');
  } finally { log.mockRestore(); }
});
