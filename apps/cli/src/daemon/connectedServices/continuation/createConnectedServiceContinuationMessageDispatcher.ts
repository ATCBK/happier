import { createHash } from 'node:crypto';

import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import type { SessionContinuationResumePromptModeV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';

import { continueConnectedServiceRecoveryForScope, type ConnectedServiceContinuationInterruption } from './continuationResumePrompt';
import type { ConnectedServiceRuntimeAuthFailureKind } from '../runtimeAuth/types';

export type { ConnectedServiceContinuationInterruption } from './continuationResumePrompt';

type ConnectedServiceContinuationMessageDispatcherDeps = Readonly<{
  credentials: StoredCredentials;
  sendMessage?: typeof sendSessionMessage;
}>;

function createContinuationLocalId(sessionId: string, attemptId: string, interruptedOriginId: string): string {
  if (!sessionId.trim() || !attemptId.trim() || !interruptedOriginId.trim()) {
    throw new Error('connected_service_continuation_identity_invalid');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, attemptId, interruptedOriginId]))
    .digest('hex')
    .slice(0, 32);
  const localId = `connected-service-continuation:${digest}`;
  const validated = readPendingLocalId(localId);
  if (validated === null) {
    throw new Error('connected_service_continuation_local_id_invalid');
  }
  return validated;
}

export function createConnectedServiceContinuationMessageDispatcher(
  deps: ConnectedServiceContinuationMessageDispatcherDeps,
) {
  const sendMessage = deps.sendMessage ?? sendSessionMessage;

  return {
    async sendContinuationPrompt(input: Readonly<{
      sessionId: string;
      prompt: string;
      localId: string;
      isCurrent?: Parameters<typeof sendSessionMessage>[0]['canAdmitPendingInput'];
    }>): Promise<Readonly<{ suppressed: boolean }>> {
      const sent = await sendMessage({
        credentials: deps.credentials,
        idOrPrefix: input.sessionId,
        message: input.prompt,
        localId: input.localId,
        pendingAdmissionMode: 'continuation_if_no_queued_user_input',
        ...(input.isCurrent ? { canAdmitPendingInput: input.isCurrent } : {}),
        requestedAction: { v: 1, kind: 'send_now' },
        resumeInactiveSession: false,
        wait: false,
        timeoutMs: 1,
      });
      if (!sent.ok) {
        throw new Error(`continuation_prompt_send_failed:${sent.code}`);
      }
      return { suppressed: sent.suppressed === true };
    },

    async enqueueInterruptedOriginContinuation(input: Readonly<{
      sessionId: string;
      attemptId: string;
      interruptedOriginId: string;
      interruption: ConnectedServiceContinuationInterruption;
      resumePromptMode: SessionContinuationResumePromptModeV1;
      customResumePrompt?: string | null;
      recoveryKind?: ConnectedServiceRuntimeAuthFailureKind | null;
      isCurrent?: Parameters<typeof sendSessionMessage>[0]['canAdmitPendingInput'];
    }>): Promise<
      | Readonly<{ status: 'not_interrupted' | 'disabled' | 'suppressed_newer_user_input' }>
      | Readonly<{ status: 'enqueued'; localId: string }>
    > {
      const continuation = await continueConnectedServiceRecoveryForScope({
        scope: { kind: 'session', sessionId: input.sessionId },
        interruption: input.interruption,
        resumePromptMode: input.resumePromptMode,
        customResumePrompt: input.customResumePrompt,
        recoveryKind: input.recoveryKind,
        deliver: async ({ prompt }) => {
          const localId = createContinuationLocalId(input.sessionId, input.attemptId, input.interruptedOriginId);
          const sent = await this.sendContinuationPrompt({ sessionId: input.sessionId, prompt, localId, isCurrent: input.isCurrent });
          return sent.suppressed ? { status: 'suppressed_newer_user_input' as const } : { status: 'enqueued' as const, localId };
        },
      });
      if (continuation.status === 'delivered') return continuation.value;
      return { status: continuation.status === 'disabled' ? 'disabled' : 'not_interrupted' };
    },
  };
}
