import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

describe('Account leaving Action admission', () => {
    it('admits focused Home sign-out as a safe client intent', async () => {
        let delivered = false;
        // Client delivery is a process boundary; admission and policy remain real.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            clientActionExecute: async () => {
                delivered = true;
                return { ok: true, result: { status: 'signed_out' } };
            },
        }));
        const result = await executor.execute('account.signOut' as ActionId,
            { serverId: 'home-a', accountId: 'alice' },
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: 'home-a', expectedAccountId: 'alice' });
        expect(result).toEqual({ ok: true, result: { status: 'signed_out' } });
        expect(delivered).toBe(true);
    });

    it.each(['account.credentials.forgetAll', 'account.delete'])(
        'refuses %s before client effects when automation cannot obtain human approval', async id => {
            let delivered = false;
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                clientActionExecute: async () => {
                    delivered = true;
                    return { ok: true, result: { status: 'completed' } };
                },
            }));
            const result = await executor.execute(id as ActionId,
                { serverId: 'home-a', accountId: 'alice',
                    ...(id === 'account.credentials.forgetAll' ? { scope: 'all-credentials' } : {}) },
                { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                    serverId: 'home-a', expectedAccountId: 'alice', actionRequestId: 'leaving-intent' });
            expect(result).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(delivered).toBe(false);
        },
    );
});
