import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionManagerSetRequestV1Schema, SessionManagerSetResultV1Schema, projectSessionManagerSourceKeyPreparationV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { SessionFollowSourceKeyPreparationResultV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';

/** The captured Action Account owns credentials, cancellation and Home currentness. */
export function createSessionManagerAction(
    account: Pick<LazyActionAccountContext, 'serverId' | 'request' | 'assertCurrent'> | null,
): NonNullable<ActionExecutorDeps['sessionManagerSet']> {
    return async ({ sessionId, managerSessionId, expectedManagerSessionId, serverId, context, signal }) => {
        if (!account) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const requestedHome = serverId ?? context.serverId;
        if (requestedHome && !areServerProfileIdentifiersEquivalent(requestedHome, account.serverId)) {
            return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
        }
        account.assertCurrent();
        const body = SessionManagerSetRequestV1Schema.parse({ managerSessionId, expectedManagerSessionId });
        const transport = getActionSpec('session.manager.set').serverTransport;
        if (!transport) throw new TypeError('Missing manager Action transport');
        const response = await account.request(transport.path.replace(':sessionId', encodeURIComponent(sessionId)), {
            method: transport.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            ...((signal ?? context.signal) ? { signal: signal ?? context.signal } : {}),
        }, { includeAuth: true });
        const payload: unknown = await response.json();
        account.assertCurrent();
        const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, payload);
        if (scopeDenial) return scopeDenial;
        const parsed = SessionManagerSetResultV1Schema.safeParse(payload);
        if (parsed.success) {
            const result = parsed.data;
            const expectedStatus = result.ok ? 200 : result.error === 'manager_cycle' ? 400
                : result.error === 'manager_cas_conflict' ? 409 : 403;
            if (response.status === expectedStatus && (!result.ok
                || (result.sessionId === sessionId && result.managerSessionId === managerSessionId))) {
                if (!result.ok || managerSessionId === null) return result;
                let preparation: SessionFollowSourceKeyPreparationResultV1;
                try {
                    preparation = await prepareSessionFollowSourceKey({
                        serverId: account.serverId, sourceSessionId: sessionId, destinationSessionId: managerSessionId,
                        ...((signal ?? context.signal) ? { signal: signal ?? context.signal } : {}),
                    });
                } catch {
                    preparation = { kind: 'waiting', reason: 'runner_unreachable' };
                }
                account.assertCurrent();
                return projectSessionManagerSourceKeyPreparationV1(result, preparation);
            }
        }
        const errorCode = response.status === 401 ? 'not_authenticated'
            : response.status === 404 ? 'unsupported_action' : 'invalid_action_output';
        return { ok: false, errorCode, error: errorCode };
    };
}
