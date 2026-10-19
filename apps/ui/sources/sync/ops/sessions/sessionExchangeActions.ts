import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { AutonomousExchangeControlRequestV1, AutonomousExchangeStatusV1Schema } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import type { z } from 'zod/mini';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const execute = createFrontDoorActionExecute();

export type SessionExchangeObservation = Readonly<{
    address: SessionAddress;
    accountId: string;
    originInputLocalId: string;
    status: z.infer<typeof AutonomousExchangeStatusV1Schema>;
}>;

export async function controlSessionExchange(
    observation: SessionExchangeObservation,
    control: AutonomousExchangeControlRequestV1['control'],
): Promise<ActionExecuteResult> {
    return execute('session.exchange.control', {
        sessionId: observation.address.sessionId,
        originInputLocalId: observation.originInputLocalId,
        observedRevision: observation.status.observedRevision,
        decision: control === 'continue_more_10' ? 'continue_more' : control,
        ...(control === 'continue_more_10' ? { additionalTurns: 10 } : {}),
    }, { surface: 'ui', serverId: observation.address.serverId, expectedAccountId: observation.accountId });
}
