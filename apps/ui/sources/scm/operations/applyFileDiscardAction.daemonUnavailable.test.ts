import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { installScmOperationsCommonModuleMocks } from './scmOperationsTestHelpers';

const modalAlert = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn());
const sessionScmChangeDiscard = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));
const evaluateScmOperationPreflight = vi.hoisted(() => vi.fn(() => ({ allowed: true, message: '' })));

installScmOperationsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlert,
                confirm: modalConfirm,
            },
        }).module;
    },
});

vi.mock('@/sync/ops', () => ({
  sessionScmChangeDiscard,
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
  withSessionProjectScmOperationLock,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
  evaluateScmOperationPreflight,
}));

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: {
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
  },
}));

describe('applyFileDiscardAction (daemon unavailable)', () => {
  it('does not add a caller confirmation before the discard Action', async () => {
    modalAlert.mockReset();
    modalConfirm.mockReset();
    sessionScmChangeDiscard.mockReset();
    sessionScmChangeDiscard.mockResolvedValueOnce({ success: true });

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      file: { fullPath: 'a.txt', status: 'modified' },
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      surface: 'file',
    } as any);

    expect(modalConfirm).not.toHaveBeenCalled();
    expect(sessionScmChangeDiscard).toHaveBeenCalledTimes(1);
  });

  it('shows daemon-unavailable alert with Retry when SCM RPC backend is unavailable', async () => {
    modalAlert.mockReset();
    modalConfirm.mockReset();
    sessionScmChangeDiscard.mockReset();

    sessionScmChangeDiscard.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      file: { fullPath: 'a.txt', status: 'modified' },
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      surface: 'file',
    } as any);

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(Array.isArray(buttons)).toBe(true);
    expect((buttons as any[]).some((b) => b?.text === 'common.retry')).toBe(true);
  });

  it('stays quiet when the person declines the Action confirmation', async () => {
    modalAlert.mockReset();
    sessionScmChangeDiscard.mockReset();
    // What the real SCM facade returns for a declined in-place confirmation.
    const { normalizeUiScmFacadeResult } = await import('@/sync/ops/scm/scmActionInvocation');
    sessionScmChangeDiscard.mockResolvedValueOnce(
      normalizeUiScmFacadeResult({ success: false, errorCode: 'approval_canceled', error: 'approval_canceled' }),
    );

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      file: { fullPath: 'a.txt', status: 'modified' },
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      surface: 'file',
    } as any);

    expect(sessionScmChangeDiscard).toHaveBeenCalledTimes(1);
    expect(modalAlert).not.toHaveBeenCalled();
  });
});
