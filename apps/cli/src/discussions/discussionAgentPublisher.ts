import { z } from 'zod/mini';
import axios from 'axios';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DiscussionAgentPublisherRequestV1Schema as PublisherRequestV1Schema, DiscussionAgentPostRequestV1Schema, DiscussionDetailsResponseV1Schema, type DiscussionAgentPublisherRequestV1, type DiscussionAgentPublisherInputV1, type DiscussionAgentPublisherPublicationInputV1 } from '@happier-dev/protocol/discussions/api';
import { bindDiscussionActionHttpRequestV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { DiscussionMessageContentV1Schema } from '@happier-dev/protocol/discussions/content';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionInputSourceSessionV1Schema, type SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { AgentRuntimeDaemonServiceTurnWitnessV1Schema, projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { RunnerMcpSessionWithContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/participants';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { openResourceDataKey } from '@/api/encryption/resourceDataKey';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionStoredContentCodec';
import { projectSessionMessageReplyOutcome, readSessionMessageReply } from '@/session/services/sessionMessageReply';
import { readApprovedDiscussionPublication, type ApprovedDiscussionSourceActionExecute } from './approvedDiscussionPublication';
import { WorkflowInvocationGetResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

/** Host-owned causal root shared by the active Session RPC and bound MCP host. */
export function readDiscussionAgentPublisherSourceSession(
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId'>>,
): SessionInputSourceSessionV1 | null {
  const current = session.getActiveTurnAdmissionWitness?.();
  if (!current?.inputId || session.getRuntimeLifetimeSignal?.()?.aborted || session.getHostTurnAbortSignal?.()?.aborted) return null;
  const source = SessionInputSourceSessionV1Schema.safeParse({ sourceSessionId: session.sessionId,
    sourceTurnId: current.turnId, sourceInputId: current.inputId, via: 'action' });
  return source.success ? source.data : null;
}

/** The host derives original-return authority; authored markers never survive an active invocation. */
export function prepareActiveDiscussionAgentPublication(params: Readonly<{
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId'>>;
  serverId: string;
  request: DiscussionAgentPublisherRequestV1;
}>): DiscussionAgentPublisherInputV1 | null {
  if (params.request.sessionId !== params.session.sessionId) return null;
  const sourceSession = readDiscussionAgentPublisherSourceSession(params.session);
  return sourceSession ? prepareDiscussionAgentPublication({ sessionId: params.session.sessionId,
    serverId: params.serverId, request: params.request, sourceSession,
    discussionAddressing: params.session.getActiveTurnAdmissionWitness?.()?.discussionAddressing }) : null;
}

function prepareDiscussionAgentPublication(params: Readonly<{
  sessionId: string;
  serverId: string;
  request: DiscussionAgentPublisherRequestV1;
  sourceSession: SessionInputSourceSessionV1;
  discussionAddressing?: DiscussionAddressingV1;
}>): DiscussionAgentPublisherInputV1 | null {
  const sourceSession = params.sourceSession;
  if (!sourceSession?.sourceInputId || !sourceSession.sourceTurnId) return null;
  const { v: _version, sessionId: _sessionId, sourceSession: _authoredSource, ...input } = params.request;
  if ('operation' in input) return { ...input, sourceSession };
  const { replyReturn: _authoredReturn, ...publication } = input;
  const addressing = params.discussionAddressing;
  if (addressing?.participantSessionId === params.sessionId
    && addressing.discussionId === publication.discussionId
    && publication.request.replyTarget?.kind === 'message'
    && publication.request.replyTarget.messageId === addressing.messageId) {
    return { ...publication, sourceSession,
      request: { ...publication.request, localId: deriveSessionMessageReplyReturnLocalIdV1({
        sessionId: params.sessionId, localId: sourceSession.sourceInputId, acceptedTurnId: sourceSession.sourceTurnId,
      }) },
      replyReturn: { serverId: params.serverId, requestLocalId: sourceSession.sourceInputId, acceptedTurnId: sourceSession.sourceTurnId },
    };
  }
  return { ...publication, sourceSession };
}

/** Private payload on the incumbent owner-only Session RPC transport. */
export const DiscussionAgentPublisherRequestV1Schema = z.union([
  z.strictObject({
    request: asHostProtocolZod(PublisherRequestV1Schema),
    witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
  }),
  z.strictObject({
    request: asHostProtocolZod(PublisherRequestV1Schema),
    approvedActionReplay: z.strictObject({ artifactId: z.string().check(z.trim(), z.minLength(1)) }),
  }),
  // Without an executing approval, only the server-validated original reply
  // can outlive its turn. Ordinary posts/create require the active witness.
  z.strictObject({
    request: asHostProtocolZod(DiscussionAgentPostRequestV1Schema).check(z.refine(request =>
      request.replyReturn !== undefined && request.request.replyTarget?.kind === 'message')),
  }),
]);
export type DiscussionAgentPublisherPrivateRequestV1 = z.infer<typeof DiscussionAgentPublisherRequestV1Schema>;

/** An Account RPC caller may name an original, but cannot author its terminal result. */
async function isExactTerminalDiscussionReturn(params: Readonly<{
  request: DiscussionAgentPublisherRequestV1;
  credentials: StoredCredentials;
  serverId: string;
  serverUrl: string;
  signal?: AbortSignal;
  executeSourceAction?: ApprovedDiscussionSourceActionExecute;
}>): Promise<boolean> {
  const { request, credentials, signal } = params;
  if ('operation' in request) return false;
  const marker = request.replyReturn;
  if (!marker || marker.serverId !== params.serverId || request.request.replyTarget?.kind !== 'message'
    || request.request.localId !== deriveSessionMessageReplyReturnLocalIdV1({ sessionId: request.sessionId,
      localId: marker.requestLocalId, acceptedTurnId: marker.acceptedTurnId })
    || request.request.mentionedAccountIds.length > 0 || (request.request.mentionedSessionIds?.length ?? 0) > 0) return false;
  const parentMessageId = request.request.replyTarget.messageId;
  return await runWithServerHttpBaseUrl(params.serverUrl, async () => {
    const original = await readSessionMessageReply({ credentials, sessionId: request.sessionId,
      localId: marker.requestLocalId, ...(signal ? { signal } : {}) });
    if (original.status !== 'available') return false;
    const progress = original.progress;
    const workflow = marker.workflow;
    if ((workflow ? progress.mode !== 'wait' || !progress.workflow
      || progress.workflow.runId !== workflow.runId || progress.workflow.invocationRecordId !== workflow.invocationRecordId
      || !['observing', 'inline', 'returned'].includes(progress.disposition)
      : progress.mode !== 'return' || !['return_pending', 'returned'].includes(progress.disposition))
      || progress.acceptedTurnId !== marker.acceptedTurnId || !progress.outcome
      || progress.discussion?.participantSessionId !== request.sessionId
      || progress.discussion.discussionId !== request.discussionId
      || progress.discussion.messageId !== parentMessageId
      // Ordinary explicit replies settle final fallback. Workflow publication
      // may rejoin its same accepted result after losing the append ACK.
      || !workflow && progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome) return false;
    if (workflow && progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome
      && (progress.outcome.publicationRef.kind !== 'discussion'
        || progress.outcome.publicationRef.discussion.serverId !== params.serverId
        || progress.outcome.publicationRef.discussion.discussionId !== request.discussionId)) return false;
    let message: string;
    if (workflow) {
      // Open through the existing Workflow Action owner, including its current
      // Run access/key census. A C2 terminal answer alone is not accepted output.
      if (!params.executeSourceAction) return false;
      const result = await params.executeSourceAction('workflow.run.invocations.get', { runId: workflow.runId,
        invocationId: workflow.invocationRecordId }, { surface: 'cli', authority: 'account_automation',
        serverId: params.serverId, ...(signal ? { signal } : {}) });
      const opened = result.ok ? WorkflowInvocationGetResultV1Schema.safeParse(result.result) : null;
      if (!opened?.success) return false;
      const delivery = opened.data.discussionResultDelivery;
      if (!delivery || delivery.discussion.serverId !== params.serverId
        || delivery.discussion.discussionId !== request.discussionId
        || delivery.messageId !== parentMessageId || delivery.throughSeq !== progress.discussion.throughSeq) return false;
      const { index, progress: invocation } = opened.data.invocation;
      if (index.lifecycle !== 'completed' || index.runId !== workflow.runId || index.id !== workflow.invocationRecordId
        || index.attempt !== workflow.invocationAttempt || invocation.attempt !== workflow.invocationAttempt
        || invocation.execution?.kind !== 'session' || invocation.execution.sessionId !== request.sessionId
        || invocation.execution.localInputId !== marker.requestLocalId || invocation.result === undefined
        || !['answer', 'pass'].includes(progress.outcome.kind)) return false;
      if (progress.outcome.kind === 'pass') {
        const projected = await projectSessionMessageReplyOutcome({ credentials, serverId: params.serverId,
          sessionId: request.sessionId, localId: marker.requestLocalId, outcome: progress.outcome,
          ...(signal ? { signal } : {}) });
        if (!projected) return false;
        message = projected.message;
      } else message = typeof invocation.result === 'string' ? invocation.result : JSON.stringify(invocation.result);
    } else {
      const projected = await projectSessionMessageReplyOutcome({ credentials, serverId: params.serverId,
        sessionId: request.sessionId, localId: marker.requestLocalId, outcome: progress.outcome, ...(signal ? { signal } : {}) });
      if (!projected) return false;
      message = projected.message;
    }
    const bound = bindDiscussionActionHttpRequestV1('discussion.get', { discussionId: request.discussionId });
    const response = await axios.get(params.serverUrl.replace(/\/+$/, '') + bound.path,
      { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` }, validateStatus: () => true, signal });
    if (response.status !== 200) return false;
    const summary = DiscussionDetailsResponseV1Schema.parse(response.data).discussion;
    if (summary.id !== request.discussionId || !summary.keyReadiness) return false;
    const key = await openResourceDataKey({ credentials, mode: summary.encryptionMode, dataEncryptionKey: summary.dataEncryptionKey });
    const crypto = key.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
      : { mode: 'e2ee' as const, ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' as const } };
    const content = DiscussionMessageContentV1Schema.parse(openSessionStoredContent({ ...crypto, content: request.request.content }));
    signal?.throwIfAborted();
    return sameStrictJsonValue(content, { v: 1, parts: [{ t: 'text', text: message }] });
  });
}

export function registerDiscussionAgentPublisher(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  serverId: string;
  serverUrl: string;
  readOwnerAccountCredentials: () => Promise<StoredCredentials | null>;
  isApprovalExecutionOriginCurrent: NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>;
  executeSourceAction?: ApprovedDiscussionSourceActionExecute;
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId' | 'postAgentDiscussionMessage'>>;
}>): void {
  params.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, async (raw: unknown, context) => {
    const denied = () => ({ v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const });
    const parsed = DiscussionAgentPublisherRequestV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.request.sessionId !== params.session.sessionId) return denied();
    const activePublication = 'witness' in parsed.data;
    if ('witness' in parsed.data) {
      const current = params.session.getActiveTurnAdmissionWitness?.();
      if (!current) return denied();
      try {
        if (!sameStrictJsonValue(parsed.data.witness, projectAgentRuntimeDaemonServiceTurnWitnessV1(current))) return denied();
      } catch { return denied(); }
    }
    const signals = [context?.signal, params.session.getRuntimeLifetimeSignal?.(),
      ...(activePublication ? [params.session.getHostTurnAbortSignal?.()] : [])]
      .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    if (signal?.aborted) return denied();
    if ('approvedActionReplay' in parsed.data) {
      let publication: DiscussionAgentPublisherPublicationInputV1 | null;
      try {
        const credentials = await params.readOwnerAccountCredentials();
        if (!credentials) return denied();
        const approved = await readApprovedDiscussionPublication({
          artifactId: parsed.data.approvedActionReplay.artifactId, request: parsed.data.request,
          credentials, sessionId: params.session.sessionId, serverId: params.serverId, serverUrl: params.serverUrl,
          callerAuthority: context?.callerAuthority,
          requesterApprovalDecision: context?.requesterApprovalDecision,
          isApprovalExecutionOriginCurrent: params.isApprovalExecutionOriginCurrent, ...(signal ? { signal } : {}),
          ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}),
        });
        if (!approved || (await params.readOwnerAccountCredentials())?.token !== credentials.token || signal?.aborted) return denied();
        const { terminalReturn, draftReview, ...reviewedOrigin } = approved;
        if (terminalReturn && !await isExactTerminalDiscussionReturn({ request: parsed.data.request, credentials,
          serverId: params.serverId, serverUrl: params.serverUrl, ...(signal ? { signal } : {}),
          ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}) })) return denied();
        const { runId: _authoredRun, toolCallId: _authoredTool, sourceSession: _authoredSource, ...reviewedRequest } = parsed.data.request;
        if (approved.replyReturn) {
          if ('operation' in reviewedRequest) return denied();
          const { v: _version, sessionId: _sessionId, replyReturn: _return, ...input } = reviewedRequest;
          publication = { ...input, ...reviewedOrigin, ...(draftReview ? { draftReview } : {}),
            request: { ...input.request, localId: deriveSessionMessageReplyReturnLocalIdV1({
              sessionId: params.session.sessionId, localId: approved.replyReturn.requestLocalId,
              ...(approved.replyReturn.acceptedTurnId ? { acceptedTurnId: approved.replyReturn.acceptedTurnId } : {}),
            }) } };
        } else {
          const prepared = approved.sourceSession ? prepareDiscussionAgentPublication({ sessionId: params.session.sessionId, serverId: params.serverId,
            request: { ...reviewedRequest, ...reviewedOrigin }, sourceSession: approved.sourceSession,
            discussionAddressing: approved.sourceSession.discussionAddressing }) : null;
          publication = prepared && !('operation' in prepared) && draftReview ? { ...prepared, draftReview } : prepared;
        }
      } catch { return denied(); }
      // Once publication begins, loss of its acknowledgement is not proof of
      // denial. Preserve the transport failure for normal outcome reconciliation.
      return publication ? await params.session.postAgentDiscussionMessage(publication, signal ? { signal } : undefined) : denied();
    }
    const { v: _version, sessionId: _sessionId, sourceSession: _authoredSource, ...request } = parsed.data.request;
    if (!activePublication) {
      if (!('replyReturn' in request) || request.replyReturn?.serverId !== params.serverId) return denied();
      try {
        const credentials = await params.readOwnerAccountCredentials();
        if (!credentials || !await isExactTerminalDiscussionReturn({ request: parsed.data.request, credentials,
          serverId: params.serverId, serverUrl: params.serverUrl, ...(signal ? { signal } : {}),
          ...(params.executeSourceAction ? { executeSourceAction: params.executeSourceAction } : {}) })
          || (await params.readOwnerAccountCredentials())?.token !== credentials.token || signal?.aborted) return denied();
      } catch { return denied(); }
      // The append owner stamps factual original provenance. Raw Account
      // operands supply neither a different causal root nor Run attribution.
      const { runId: _authoredRun, toolCallId: _authoredTool, ...terminal } = request;
      return await params.session.postAgentDiscussionMessage(terminal, signal ? { signal } : undefined);
    }
    const publication = prepareActiveDiscussionAgentPublication({ session: params.session, serverId: params.serverId, request: parsed.data.request });
    if (!publication) return denied();
    // Workflow replies are accepted by their invocation owner first. Refuse an
    // active explicit answer to that same parent until the durable result path
    // can publish it under C2's one original-input obligation.
    if (!('operation' in publication) && publication.replyReturn) {
      const credentials = await params.readOwnerAccountCredentials();
      if (!credentials) return denied();
      const original = await readSessionMessageReply({ credentials, sessionId: params.session.sessionId,
        localId: publication.replyReturn.requestLocalId, ...(signal ? { signal } : {}) });
      if (original.status === 'available' && original.progress.workflow) return denied();
    }
    return await params.session.postAgentDiscussionMessage(publication, signal ? { signal } : undefined);
  });
}
