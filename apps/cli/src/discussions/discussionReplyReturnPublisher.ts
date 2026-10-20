import { DiscussionAgentPostRequestV1Schema, DiscussionAgentPostResponseV1Schema,
  type DiscussionAgentPostResponseV1 } from '@happier-dev/protocol/discussions/api';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionInputSourceSessionV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readSessionMessageReply, type DiscussionReplyReturnPublisher } from '@/session/services/sessionMessageReply';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { logger } from '@/ui/logger';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

/** Account composition supplies policy and resource crypto, never a second writer. */
export function createDiscussionReplyReturnPublisher(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
}>): DiscussionReplyReturnPublisher {
  const resolveCurrentOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: params.serverHttpBaseUrl,
    resolveCurrentMachineId: () => params.machineId });
  return async (original, options) => {
    const denied = (): DiscussionAgentPostResponseV1 => ({ v: 1, ok: false, error: 'discussion_post_denied' });
    const signal = options?.signal && options.signal !== params.signal
      ? AbortSignal.any([params.signal, options.signal]) : params.signal;
    const current = async () => !signal.aborted && await params.isCurrent() && !signal.aborted;
    if (original.serverId !== params.serverId
      || original.discussion.participantSessionId !== original.requestSessionId || !await current()) return denied();
    const origin = await resolveCurrentOrigin(signal);
    if (!origin || !await current()) return denied();
    const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: original.requestSessionId,
      localId: original.requestLocalId, acceptedTurnId: original.acceptedTurnId });
    if (!original.workflow) {
      // Recovery's result projection can await while an explicit answer commits.
      // Reconcile the same original before even preparing another Action approval;
      // the append owner's later dedupe alone cannot prevent a duplicate prompt.
      const latest = await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => readSessionMessageReply({
        credentials: params.credentials, sessionId: original.requestSessionId, localId: original.requestLocalId, signal,
      }));
      const progress = latest.status === 'available' ? latest.progress : undefined;
      if (!await current() || progress?.mode !== 'return' || progress.disposition !== 'return_pending'
        || progress.acceptedTurnId !== original.acceptedTurnId || !progress.outcome
        || progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome
        || progress.discussion?.participantSessionId !== original.requestSessionId
        || progress.discussion.discussionId !== original.discussion.discussionId
        || progress.discussion.messageId !== original.discussion.messageId
        || progress.discussion.throughSeq !== original.discussion.throughSeq) return denied();
    }
    const { createCliActionExecutor } = await import('@/session/actions/createCliActionExecutor');
    if (!await current()) return denied();
    const receipt: { value?: DiscussionAgentPostResponseV1 } = {};
    const transportFailure: { value?: Readonly<{ error: unknown }> } = {};
    let phase = 'action_admission';
    const executor = createCliActionExecutor({ token: params.credentials.token, credentials: params.credentials,
      sessionId: '', mode: 'plain', ctx: null, serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl,
      serverIdentityId: origin.serverIdentityId,
      isCredentialCurrent: current,
      ...(params.actionsSettingsProvider ? { actionsSettingsProvider: params.actionsSettingsProvider } : {}),
      postAgentDiscussionMessage: async request => {
        phase = 'publisher_request';
        const parsed = DiscussionAgentPostRequestV1Schema.safeParse(request);
        if (!parsed.success || parsed.data.sessionId !== original.requestSessionId
          || parsed.data.discussionId !== original.discussion.discussionId || parsed.data.request.localId !== localId
          || parsed.data.request.replyTarget?.kind !== 'message'
          || parsed.data.request.replyTarget.messageId !== original.discussion.messageId || !await current()) return denied();
        phase = 'session_transport';
        const transport = await resolveSessionTransportContext({ credentials: params.credentials,
          idOrPrefix: original.requestSessionId, signal });
        if (!transport.ok || transport.sessionId !== original.requestSessionId || !await current()) return denied();
        const replyReturn = { serverId: params.serverId, requestLocalId: original.requestLocalId,
          ...(original.workflow ? { workflow: original.workflow } : {}),
          ...(original.acceptedTurnId ? { acceptedTurnId: original.acceptedTurnId } : {}) };
        phase = 'session_publisher';
        try {
          receipt.value = DiscussionAgentPostResponseV1Schema.parse(await callSessionRpc({
            token: params.credentials.token, sessionId: transport.sessionId,
            method: SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1,
            request: { request: { ...parsed.data, replyReturn } },
            authorityCeiling: 'account_automation', timeoutMs: null, signal,
            ...(transport.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', ctx: transport.ctx }),
          }));
        } catch (error) {
          transportFailure.value = { error };
          throw error;
        }
        return receipt.value;
      },
    });
    // These are retained original-input facts, not a fabricated active witness.
    const sessionInputSource = original.acceptedTurnId ? SessionInputSourceSessionV1Schema.parse({
      sourceSessionId: original.requestSessionId, sourceTurnId: original.acceptedTurnId,
      sourceInputId: original.requestLocalId, via: 'action', discussionAddressing: original.discussion,
    }) : undefined;
    const result = await executor.execute('discussion.reply', { discussionId: original.discussion.discussionId, localId,
      replyTarget: { kind: 'message', messageId: original.discussion.messageId },
      content: { v: 1, parts: [{ t: 'text', text: original.message }] },
    }, { serverId: params.serverId, surface: 'agent', authority: 'account_automation',
      defaultSessionId: original.requestSessionId, defaultSessionMachineId: params.machineId,
      actionCaller: { kind: 'host' },
      discussionReplyReturn: { serverId: params.serverId, requestLocalId: original.requestLocalId,
        ...(original.workflow ? { workflow: original.workflow } : {}),
        ...(original.acceptedTurnId ? { acceptedTurnId: original.acceptedTurnId } : {}) },
      actionRequestId: localId, signal, ...(sessionInputSource ? { sessionInputSource } : {}),
      ...(original.actionRequestAttributionV1 ? { actionRequestAttributionV1: original.actionRequestAttributionV1 } : {}),
    });
    // Action admission reports failures as values. Do not reinterpret a native
    // append whose acknowledgement was lost as an authoritative refusal.
    if (transportFailure.value) throw transportFailure.value.error;
    if (!receipt.value) logger.warnLocalFile('[Discussion reply return] Action has no publication receipt', {
      errorCode: result.ok ? 'publication_pending' : result.errorCode, phase,
    });
    // Approval/denial/unavailable publication leaves the original obligation pending.
    return receipt.value ?? denied();
  };
}
