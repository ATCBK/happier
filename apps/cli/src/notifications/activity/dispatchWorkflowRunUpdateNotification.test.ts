import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createWorkflowRunCommittedNotificationHandler } from './dispatchWorkflowRunUpdateNotification';

describe('createWorkflowRunCommittedNotificationHandler', () => {
  it.each([['disabled', 404, 'feature_unavailable', true], ['unavailable', 503, 'internal', false]] as const)(
    'keeps implicit Workflow notifications separate from %s Follow support', async (_kind, status, error, delivers) => {
      const transport = vi.spyOn(axios, 'get').mockResolvedValue({ status, data: { error } });
      const dispatch = vi.fn(async () => ({ attemptedChannels: 1, deliveredChannels: 1 }));
      try {
        const handler = createWorkflowRunCommittedNotificationHandler({ dispatch, getSettingsSnapshot: () => ({ settings: null }),
          followSource: { token: 'token', serverHttpBaseUrl: 'https://home.test' } });
        await handler({ run: { id: 'run-1' }, result: { state: 'failed' } });
        expect(dispatch).toHaveBeenCalledTimes(delivers ? 1 : 0);
      } finally { transport.mockRestore(); }
    },
  );
  it('emits review required only for a durable held-entry event', async () => {
    const dispatch = vi.fn(async () => ({ attemptedChannels: 1, deliveredChannels: 1 }));
    const handler = createWorkflowRunCommittedNotificationHandler({ getSettingsSnapshot: () => ({ settings: null }), dispatch });
    await handler({ run: { id: 'run-1' }, result: { state: 'waiting_for_review' }, reviewEntry: true });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ event: {
      topic: 'workflow_run_update', runId: 'run-1', updateKind: 'review_required',
    } }));
    dispatch.mockClear();
    await handler({ run: { id: 'run-1' }, result: { state: 'waiting_for_review' } });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each([
    ['succeeded', 'completed'],
    ['failed', 'failed'],
    ['outcome_uncertain', 'outcome_uncertain'],
    ['paused', 'paused'],
    ['interrupted', 'interrupted'],
  ] as const)('projects a committed %s result to %s', async (state, updateKind) => {
    const dispatch = vi.fn(async () => ({ attemptedChannels: 1, deliveredChannels: 1 }));
    const handler = createWorkflowRunCommittedNotificationHandler({
      getSettingsSnapshot: () => ({ settings: null, settingsSecretsReadKeys: [] }),
      dispatch,
    });

    await handler({
      run: { id: 'run-1' },
      result: { state, reason: state === 'succeeded' ? undefined : 'private-or-provider-detail' },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      event: {
        topic: 'workflow_run_update',
        runId: 'run-1',
        updateKind,
      },
    }));
  });

  it.each(['cancelled', 'waiting_for_review'] as const)('does not emit a workflow update for %s settlement', async (state) => {
    const dispatch = vi.fn();
    const handler = createWorkflowRunCommittedNotificationHandler({
      getSettingsSnapshot: () => ({ settings: null, settingsSecretsReadKeys: [] }),
      dispatch,
    });

    await handler({ run: { id: 'run-1' }, result: { state } });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('preserves collect-outcomes success as completed with failures', async () => {
    const dispatch = vi.fn(async () => ({ attemptedChannels: 1, deliveredChannels: 1 }));
    const handler = createWorkflowRunCommittedNotificationHandler({
      getSettingsSnapshot: () => ({ settings: null, settingsSecretsReadKeys: [] }),
      dispatch,
    });

    await handler({
      run: { id: 'run-1' },
      result: { state: 'succeeded', completedWithFailures: true },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      event: {
        topic: 'workflow_run_update',
        runId: 'run-1',
        updateKind: 'completed_with_failures',
      },
    }));
  });

  it('does not let notification delivery failure change an already committed Run outcome', async () => {
    const handler = createWorkflowRunCommittedNotificationHandler({
      getSettingsSnapshot: () => ({ settings: null, settingsSecretsReadKeys: [] }),
      dispatch: vi.fn(async () => {
        throw new Error('notification transport unavailable');
      }),
    });

    await expect(handler({ run: { id: 'run-1' }, result: { state: 'succeeded' } }))
      .resolves.toBeUndefined();
  });

  it('does not let notification settings lookup failure change an already committed Run outcome', async () => {
    const dispatch = vi.fn();
    const handler = createWorkflowRunCommittedNotificationHandler({
      getSettingsSnapshot: () => {
        throw new Error('settings unavailable');
      },
      dispatch,
    });

    await expect(handler({ run: { id: 'run-1' }, result: { state: 'failed' } }))
      .resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
