import { AutonomousExchangeStatusV1Schema } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

/** The source-backed read shared by Action preparation and the open check-in banner. */
export async function readSessionExchangeStatus(
    account: Pick<LazyActionAccountContext, 'request' | 'assertCurrent'>,
    sessionId: string,
    originInputLocalId: string,
    signal?: AbortSignal,
) {
    account.assertCurrent();
    const response = await account.request(`/v2/sessions/${encodeURIComponent(sessionId)}/exchanges/${encodeURIComponent(originInputLocalId)}`,
        { method: 'GET', ...(signal ? { signal } : {}) });
    account.assertCurrent();
    if (!response.ok) throw new Error(response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : 'exchange_unavailable');
    const status = AutonomousExchangeStatusV1Schema.parse(await response.json());
    account.assertCurrent();
    return status;
}
