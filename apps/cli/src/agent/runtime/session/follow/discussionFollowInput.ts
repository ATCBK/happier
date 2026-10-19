import { DiscussionReadResultV1Schema } from '@happier-dev/protocol/discussions/actions';
import { countDocPassageThreadsV1, readCommittedDiscussionMessage } from '@happier-dev/protocol/actions/executor/docCollaborationActions';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SessionInputRequestV1Schema, assertSessionInputAdmissionReceiptForAuthorityV1,
  buildTrustedHostSessionInputAdmissionV1, readSessionInputAuthority, readSessionInputCausalPermissionAuthorityV1,
  readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveDiscussionFollowInputLocalIdV1, type SessionFollowDiscussionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { deriveSessionInputActionRequestAttributionV1, materializeActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '@/api/session/transcriptMessageLookup';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { buildCausalSessionInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { stampTurnFacts } from '../turn/stampTurnFacts';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveSessionInputTargetMachineId } from '@/session/services/sessionInputAdmissionIdentity';
import { sealSessionStoredContent, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

/** The existing Follow observation becomes one original input through the incumbent Pending owner. */
export function createDiscussionFollowInputIntake(input: Readonly<{
  session: Pick<ApiSessionClient, 'sessionId' | 'getServerBinding' | 'getServerFeaturesSnapshot'
    | 'getMachineAdmissionTransport' | 'runSessionFollowSourceRequest'>;
  credentials: StoredCredentials;
  /** Existing local daemon launch boundary, after accepted original Pending custody. */
  spawnSession?: Parameters<typeof sendSessionMessage>[0]['spawnSession'];
}>) {
  const binding = input.session.getServerBinding();
  const discussionAction = createDiscussionActionDeps({ credentials: input.credentials, serverId: binding.serverId,
    serverHttpBaseUrl: binding.serverUrl, resolveServerFeaturesSnapshot: () => input.session.getServerFeaturesSnapshot() }).discussionAction!;
  const artifacts = createCredentialedAccountArtifactStore(input.credentials);
  return async ({ observation, signal }: Readonly<{ observation: SessionFollowDiscussionPendingObservationV1; signal: AbortSignal }>): Promise<boolean> => {
    if (signal.aborted || observation.destinationSessionId !== input.session.sessionId) return false;
    return input.session.runSessionFollowSourceRequest({ credentials: input.credentials, request: async () => {
      // C1 supplies the persisted relation policy and committed original's
      // classification. Intake must not replace either with a local preset.
      const delivery = resolveFollowDeliveryV1({ policies: [observation.policy], event: observation.event });
      if (!delivery.selected) return false;
      const { addressing } = observation;
      const opened = DiscussionReadResultV1Schema.safeParse(await discussionAction({ actionId: 'discussion.read',
        input: { discussionId: addressing.discussionId, afterSeq: addressing.throughSeq - 1, throughSeq: addressing.throughSeq },
        context: { surface: 'cli', authority: 'account_automation', serverId: binding.serverId }, signal }));
      if (!opened.success || opened.data.incomplete || opened.data.serverId !== binding.serverId
        || opened.data.discussionId !== addressing.discussionId) return false;
      const question = opened.data.messages.find(message => message.id === addressing.messageId && message.seq === addressing.throughSeq);
      if (!question?.content || !question.addressingV1?.participantSessionIds.includes(input.session.sessionId)) return false;
      let root = question;
      const ancestors = new Set([question.id]);
      while (root.replyTarget?.kind === 'message') {
        const parentId = root.replyTarget.messageId;
        if (ancestors.has(parentId)) return false;
        ancestors.add(parentId);
        const result = await readCommittedDiscussionMessage({ kind: 'discussion', discussion: {
          serverId: binding.serverId, discussionId: addressing.discussionId }, messageId: parentId },
        { surface: 'cli', authority: 'account_automation', serverId: binding.serverId, signal }, discussionAction,
        { throughSeq: addressing.throughSeq });
        if (!result.ok) return false;
        root = result.message;
      }
      const rootSource = root.replyTarget?.kind === 'doc_passage' ? root.replyTarget.doc : null;
      const passage = 'kind' in question.content ? question.content.kind === 'doc_passage_comment'
        ? question.content.passage : question.content.proposal.target : null;
      if (passage && (!rootSource || passage.ref.artifactId !== rootSource.ref.artifactId)) return false;
      if (root.messageRef.discussion.serverId !== binding.serverId
        || root.messageRef.discussion.discussionId !== addressing.discussionId) return false;
      // A redo can carry a newer committed basis than the original thread root.
      // Stored labels belong to the creator's device. Only the exact admitted
      // row's current Home qualifies the compact card and its subsequent reads.
      const source = rootSource ? { ref: { ...rootSource.ref, serverId: root.messageRef.discussion.serverId },
        revision: passage?.revision ?? rootSource.revision } : null;
      const content = 'kind' in question.content ? question.content.kind === 'doc_passage_comment'
        ? question.content.content : { v: 1 as const, parts: [{ t: 'text' as const, text: question.content.proposal.reason }] }
        : question.content;
      // A typed Doc payload must never fall back to serializing its sealed source.
      if ('kind' in question.content && !source) return false;
      let doc: Readonly<{ docRef: NonNullable<typeof source>['ref']; title: string | null;
        revision: NonNullable<typeof source>['revision']; openCommentCount: number | null; threadRef: typeof question.messageRef }> | undefined;
      if (source) {
        let header: Awaited<ReturnType<typeof artifacts.readHeader>>;
        try {
          header = await runWithServerHttpBaseUrl(binding.serverUrl, () => artifacts.readHeader(source.ref.artifactId,
            { signal, prepareRecipients: false }));
        } catch {
          signal.throwIfAborted();
          return false;
        }
        if (!header || header.header.title !== undefined && typeof header.header.title !== 'string') return false;
        const openCommentCount = await countDocPassageThreadsV1(source.ref,
          { surface: 'cli', authority: 'account_automation', serverId: binding.serverId, signal }, discussionAction);
        doc = { docRef: source.ref, title: typeof header.header.title === 'string' ? header.header.title : null, revision: source.revision,
          openCommentCount, threadRef: root.messageRef };
      }
      const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
      const questionText = `Answer this original Discussion question. History reads are bounded through sequence ${addressing.throughSeq}.${doc ? ' Read document text explicitly with doc.read using the card docRef.' : ''}\n${JSON.stringify({
        discussionId: addressing.discussionId, messageId: addressing.messageId, content, ...(doc ? { doc } : {}),
      })}`;
      let actionRequestAttributionV1 = materializeActionRequestAttributionV1({
        requestRef: localId, requester: { serverId: binding.serverId, accountId: question.authorAccountId },
        persona: { serverId: binding.serverId, sessionId: input.session.sessionId },
        origin: { kind: 'discussion', discussion: { serverId: binding.serverId, discussionId: addressing.discussionId }, messageId: question.id },
      });
      let admission = buildTrustedHostSessionInputAdmissionV1('agent');
      if (question.producerV1) {
        const sourceSession = question.producerV1.sourceSession;
        if (!sourceSession?.sourceInputId) return false;
        const serverFeaturesSnapshot = input.session.getServerFeaturesSnapshot();
        const accountId = readAccountIdFromToken(input.credentials.token);
        if (accountId && question.authorAccountId && question.authorAccountId !== accountId) {
          // This only requests custody. Pending proves the committed producer
          // and retains its own hold; no source authority or permission is made
          // up when the other Account's private original cannot be hydrated.
          const transport = input.session.getMachineAdmissionTransport();
          if (!transport) return false;
          const target = await resolveSessionTransportContext({ credentials: input.credentials, idOrPrefix: input.session.sessionId,
            signal, ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}) });
          if (!target.ok) return false;
          const targetMachineId = resolveSessionInputTargetMachineId({ rawSession: target.rawSession,
            decryptedMetadata: tryDecryptSessionOwnerMetadataView({ credentials: input.credentials, rawSession: target.rawSession,
              accountEncryptionMode: target.accountEncryptionCurrentness.mode }) });
          if (!targetMachineId) return false;
          const result = await transport({ v: 1, sessionId: input.session.sessionId, targetMachineId, localId,
            requestedAction: { v: 1, kind: 'enqueue' }, reply: { mode: 'return', discussion: addressing, sourceSession },
            content: sealSessionStoredContent({ ...target, payload: { role: 'user', content: { type: 'text', text: questionText } },
              idempotencyKey: `session-input:v1:${input.session.sessionId}:${localId}` }),
          }, { timeoutMs: resolveSessionMessageAdmissionTimeoutMs(), signal });
          return result.status === 'accepted' || result.status === 'alreadyAccepted';
        }
        const source = await resolveSessionTransportContext({ credentials: input.credentials, idOrPrefix: sourceSession.sourceSessionId,
          signal, ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}) });
        if (!source.ok || source.sessionId !== sourceSession.sourceSessionId || typeof source.rawSession.workDepth !== 'number') return false;
        const original = await findTranscriptEncryptedMessageByLocalIdV2({ token: input.credentials.token, serverUrl: binding.serverUrl,
          sessionId: sourceSession.sourceSessionId, localId: sourceSession.sourceInputId, signal });
        if (original.type !== 'found' || original.message.messageRole !== 'user') return false;
        const body = openSessionMessageContent({ ...source, content: original.message.content });
        const meta = body && typeof body === 'object' && 'meta' in body ? body.meta : undefined;
        const authority = readSessionInputAuthority(meta, 'stored');
        const causalPermissionAuthority = readSessionInputCausalPermissionAuthorityV1(meta, 'stored');
        const provenance = readSessionMessageProvenance(meta, 'stored') ?? undefined;
        if (authority?.v !== 1 || !causalPermissionAuthority || !provenance) return false;
        assertSessionInputAdmissionReceiptForAuthorityV1({ authority, inputAdmissionReceipt: original.message.inputAdmissionReceipt });
        const originalAttribution = deriveSessionInputActionRequestAttributionV1({
          requestRef: original.message.localId, persona: { serverId: binding.serverId, sessionId: source.sessionId },
          messageRole: original.message.messageRole, inputAdmissionReceipt: original.message.inputAdmissionReceipt, inputAuthority: authority,
          origin: { kind: 'session', session: { serverId: binding.serverId, sessionId: source.sessionId }, messageId: original.message.id },
        });
        if (!originalAttribution) return false;
        actionRequestAttributionV1 = originalAttribution;
        const turnFacts = stampTurnFacts({ sessionWorkDepth: source.rawSession.workDepth, provenance });
        admission = buildCausalSessionInputAdmissionV1({ ...sourceSession, causalPermissionAuthority, actionRequestAttributionV1,
          callerDepth: readAgentStartCallerWorkDepthV1({ kind: 'session', sessionId: source.sessionId,
            starterDepth: source.rawSession.workDepth, turnDepth: turnFacts.workDepth }) });
      }
      const machineAdmissionTransport = input.session.getMachineAdmissionTransport();
      const result = await sendSessionMessage({ credentials: input.credentials, idOrPrefix: input.session.sessionId,
        localId, wait: false, timeoutMs: resolveSessionMessageAdmissionTimeoutMs(),
        message: questionText,
        inputAdmission: { provenance: admission.provenance, request: SessionInputRequestV1Schema.parse({ ...admission.request,
          discussionAddressing: addressing, actionRequestAttributionV1, replyIntent: { mode: 'return' } }) },
        executionAuthority: 'account_automation', resumeInactiveSession: delivery.session.wake,
        ...(input.spawnSession ? { spawnSession: input.spawnSession } : {}),
        ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}), signal });
      return result.ok && !result.suppressed;
    } });
  };
}
