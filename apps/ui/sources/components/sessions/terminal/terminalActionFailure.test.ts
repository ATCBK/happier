import { beforeEach, describe, expect, it, vi } from 'vitest';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit')).createModalModuleMock({ spies: { alert } }).module);

import { t } from '@/text';
import { presentTerminalActionFailure } from './terminalActionFailure';

describe('presentTerminalActionFailure', () => {
    beforeEach(() => alert.mockClear());

    it('says a close that waits for approval is waiting, not that it failed', () => {
        presentTerminalActionFailure({ errorCode: 'approval_request_created', error: 'approval_request_created' });
        presentTerminalActionFailure({ errorCode: 'terminal_approval_cancellation_pending', error: 'terminal_approval_cancellation_pending' });
        expect(alert).toHaveBeenCalledTimes(2);
        expect(alert).toHaveBeenNthCalledWith(1, t('approvals.waitingForYou'));
        expect(alert).toHaveBeenNthCalledWith(2, t('approvals.waitingForYou'));
    });

    it('keeps the generic failure for a real failure', () => {
        presentTerminalActionFailure({ errorCode: 'terminal_not_found', error: 'terminal_not_found' });
        expect(alert).toHaveBeenCalledWith(t('terminalWorkspace.actionFailed'));
    });
});
