import { PluginError } from '@happier-dev/plugin-sdk';
import type { AgentTranscriptIdentityCodec, AgentTranscriptSessionEventPublisher } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { z } from 'zod/mini';

const opaqueId = z.string().check(z.refine((value) => value.trim().length > 0));
const requestSchema = z.strictObject({ providerSessionId: opaqueId, facts: z.array(z.strictObject({
    sourceMessageId: opaqueId, role: z.enum(['user', 'assistant']), localId: opaqueId,
})) });
const resultSchema = z.strictObject({
    committedSourceMessageIds: z.array(opaqueId), hostAuthoredUserMessageIds: z.array(opaqueId),
    coverage: z.strictObject({ complete: z.boolean(), unmappedUsers: z.number().check(z.int(), z.nonnegative()), unmappedAgents: z.number().check(z.int(), z.nonnegative()) }),
});

function projectFields(value: Readonly<Record<string, unknown>> | null, fields: readonly string[]): Readonly<Record<string, unknown>> {
    return Object.fromEntries(fields.filter((field) => value && Object.hasOwn(value, field)).map((field) => [field, value![field]]));
}

/** One bound reader; the selected Agent owns correlation, not general transcript/metadata reads. */
export function createBoundTranscriptIdentityReconciler(params: Readonly<{
    agentId: string;
    sessionId: string;
    session: Pick<ApiSessionClient, 'sessionId' | 'getMetadataSnapshot' | 'fetchCommittedTranscriptIdentitySnapshot'>;
    signal: AbortSignal;
    assertCurrent: () => void;
    readProviderSessionId: () => string | null;
    readCodec: () => AgentTranscriptIdentityCodec | null;
}>): AgentTranscriptSessionEventPublisher['reconcileSourceIdentities'] {
    return async (input) => {
        const parsed = requestSchema.safeParse(input);
        if (!parsed.success) throw new PluginError({ code: 'native_agent_transcript_identity_request_invalid', message: 'Invalid transcript source identities' });
        const request = parsed.data;
        const assertScope = (): void => {
            params.signal.throwIfAborted();
            params.assertCurrent();
            if (params.sessionId !== params.session.sessionId || params.readProviderSessionId() !== request.providerSessionId) {
                throw new PluginError({ code: 'native_agent_transcript_session_scope_mismatch', message: 'Transcript identity scope does not match the current native Session' });
            }
        };
        assertScope();
        const codec = params.readCodec();
        if (!codec) throw new PluginError({ code: 'native_agent_transcript_identity_unsupported', message: 'The selected Agent does not support transcript identity reconciliation' });
        const snapshot = await params.session.fetchCommittedTranscriptIdentitySnapshot({ signal: params.signal });
        assertScope();
        if (params.readCodec() !== codec) throw new PluginError({ code: 'plugin_generation_stale', message: 'Transcript identity codec was retired' });
        const result = resultSchema.safeParse(codec.reconcile({ ...request,
            metadata: projectFields(params.session.getMetadataSnapshot(), codec.metadataFields),
            baseline: { complete: snapshot.complete, rows: snapshot.rows
                .filter((row) => !row.provider || row.provider === params.agentId)
                .map((row) => ({ localId: row.localId, role: row.role, meta: projectFields(row.meta, codec.messageMetadataFields) })) },
        }));
        const sourceIds = new Set(request.facts.map((fact) => fact.sourceMessageId));
        const userIds = new Set(request.facts.filter((fact) => fact.role === 'user').map((fact) => fact.sourceMessageId));
        if (!result.success || result.data.committedSourceMessageIds.some((id) => !sourceIds.has(id)) || result.data.hostAuthoredUserMessageIds.some((id) => !userIds.has(id))
            || (result.data.coverage.complete && (result.data.coverage.unmappedUsers !== 0 || result.data.coverage.unmappedAgents !== 0))) {
            throw new PluginError({ code: 'native_agent_transcript_identity_result_invalid', message: 'Invalid transcript identity reconciliation result' });
        }
        assertScope();
        return result.data;
    };
}
