import { SessionAgentTransitionBriefPreviewRequestV1Schema, SessionAgentTransitionBriefPreviewV1Schema, SessionContinuationInspectionBatchRequestV1Schema, SessionContinuationInspectionBatchResultV1Schema, SessionContinuationInspectionRequestV1Schema, SessionContinuationInspectionV1Schema } from '@happier-dev/protocol/sessions/agentTransition';
import type { SessionAgentTransitionBriefPreviewV1, SessionContinuationInspectionV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';

/**
 * Machine-scoped read-only continuation operations. Mutation enters through
 * the canonical admitted Account Action transport, not a parallel raw RPC.
 *
 * All are thin: request validation in, the canonical owner, zod-validated
 * result out. No transition state, retry loop, or recovery command lives here.
 */

export type SessionAgentTransitionRpcRegistrationOptions = Readonly<{
    readCredentials: () => Promise<StoredCredentials | null>;
}>;

const CREDENTIALS_UNAVAILABLE_INSPECTION: SessionContinuationInspectionV1 = {
    type: 'unavailable',
    reason: 'operation_unavailable',
};

/**
 * A process with no credentials cannot read the Session at all, which is the
 * same standing as a Session this machine cannot address. It is deliberately
 * NOT `empty`: reporting "nothing was carried over" because we could not look
 * is the one answer this surface must never give.
 */
const CREDENTIALS_UNAVAILABLE_BRIEF_PREVIEW: SessionAgentTransitionBriefPreviewV1 = {
    type: 'unavailable',
    reason: 'unsupported_session',
};

export function registerSessionAgentTransitionRpcHandlers(
    rpc: RpcHandlerRegistrar,
    options: SessionAgentTransitionRpcRegistrationOptions,
): void {
    rpc.registerHandler(RPC_METHODS.SESSION_CONTINUATION_INSPECT, async (raw: unknown) => {
        const parsed = SessionContinuationInspectionRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return SessionContinuationInspectionV1Schema.parse({
                type: 'unavailable',
                reason: 'unsupported_session',
            });
        }
        const credentials = await options.readCredentials();
        if (!credentials) {
            return SessionContinuationInspectionV1Schema.parse(CREDENTIALS_UNAVAILABLE_INSPECTION);
        }
        const { inspectSessionContinuation } = await import('@/session/agentTransition/sessionContinuationInspection');
        const inspection = await inspectSessionContinuation({
            credentials,
            request: parsed.data,
        });
        return SessionContinuationInspectionV1Schema.parse(inspection);
    });

    rpc.registerHandler(RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH, async (raw: unknown) => {
        const parsed = SessionContinuationInspectionBatchRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return SessionContinuationInspectionBatchResultV1Schema.parse({ v: 1, inspections: [] });
        }
        const credentials = await options.readCredentials();
        if (!credentials) {
            return SessionContinuationInspectionBatchResultV1Schema.parse({
                v: 1,
                inspections: parsed.data.selections.map(() => CREDENTIALS_UNAVAILABLE_INSPECTION),
            });
        }
        const { inspectSessionContinuations } = await import('@/session/agentTransition/sessionContinuationInspection');
        return SessionContinuationInspectionBatchResultV1Schema.parse(
            await inspectSessionContinuations({ credentials, request: parsed.data }),
        );
    });

    rpc.registerHandler(RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW, async (raw: unknown) => {
        const parsed = SessionAgentTransitionBriefPreviewRequestV1Schema.safeParse(raw);
        if (!parsed.success) {
            return SessionAgentTransitionBriefPreviewV1Schema.parse({
                type: 'unavailable',
                reason: 'unsupported_session',
            });
        }
        const credentials = await options.readCredentials();
        if (!credentials) {
            return SessionAgentTransitionBriefPreviewV1Schema.parse(CREDENTIALS_UNAVAILABLE_BRIEF_PREVIEW);
        }
        const { previewSessionAgentTransitionBrief } = await import('@/session/agentTransition/previewSessionAgentTransitionBrief');
        const preview = await previewSessionAgentTransitionBrief({
            credentials,
            request: parsed.data,
        });
        return SessionAgentTransitionBriefPreviewV1Schema.parse(preview);
    });
}
