import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import type { ComposerAttachmentValueV1, ComposerAttachmentResolveRequestV1, ComposerAttachmentResolveResultV1, PluginContributionIdentityV1, ProviderBoundModelRef } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { UsagePromptCompositionSchema, type UsagePromptComposition, type UsagePromptCompositionComponent } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import { createPromptCompositionScope, type PromptCompositionScope } from '@/agent/prompting/promptComposition';
import { logger } from '@/ui/logger';
import { normalizePermissionModeQueuedPromptLocalIds, type PermissionModeQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import type { SessionClientInteractionApi } from '@/api/session/client/transport/sessionClientInteractionApi';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import {
  resolveStructuredInputProviderDispatchContext,
  ResolvedMentionContextTooLargeError,
  StructuredInputComposerReferenceUnavailableError,
  StructuredInputSessionMediaProjectionError,
  StructuredInputMentionResolutionError,
  StructuredInputComposerAttachmentResolutionError,
  StructuredInputComposerAttachmentUnavailableError,
  type StructuredInputCatalogReaders,
  type StructuredInputComposerAttachmentResolver,
  type StructuredInputComposerReferenceResolver,
} from './resolveStructuredInputProviderContext';

export type ComposerAttachmentDispatchResolver = (input: Readonly<{
  sessionId: string;
  attachment: PluginContributionIdentityV1;
  request: ComposerAttachmentResolveRequestV1<ComposerAttachmentValueV1>;
  signal: AbortSignal;
}>) => Promise<ComposerAttachmentResolveResultV1>;

export function projectSessionComposerAttachmentDispatchInput(
  input: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0],
  sessionId: string,
): Parameters<ComposerAttachmentDispatchResolver>[0] {
  const request = 'scope' in input.request
    ? (() => {
        if (input.request.scope.kind !== 'session' || input.request.scope.sessionId !== sessionId) {
          throw new StructuredInputComposerAttachmentUnavailableError();
        }
        return Object.freeze({
          sessionId,
          localId: input.request.localId,
          attachments: input.request.attachments,
        });
      })()
    : input.request;
  return Object.freeze({
    sessionId,
    attachment: input.attachment,
    request,
    signal: input.signal,
  });
}

export type SessionInputDispatchServices = Readonly<{
  sessionId?: string;
  reconcileSessionInputForProviderDispatch?: SessionClientInteractionApi['reconcileSessionInputForProviderDispatch'];
  catalogs?: StructuredInputCatalogReaders;
  resolveComposerReference?: StructuredInputComposerReferenceResolver['resolve'];
  resolveComposerAttachmentForDispatch?: ComposerAttachmentDispatchResolver;
  /** Only exact host-plan fragments actually injected into this dispatch. */
  injectedPromptComponents?: readonly UsagePromptCompositionComponent[];
  retainPromptComposition?: (composition: UsagePromptComposition) => Promise<void>;
  /** Ephemeral identity of the complete dispatched host request, never a quality measurement. */
  modelRequest?: Readonly<{ scope: PromptCompositionScope; startupInstructions: string; toolSelection?: unknown;
    selection?: ProviderBoundModelRef; readSelection?: () => ProviderBoundModelRef }>;
}>;

/** The shared final host preparation boundary for normal input and in-flight steer. */
export async function prepareSessionInputForProviderDispatch(input: Readonly<{
  prompt: PermissionModeQueuedPrompt;
  transformedUserText: string;
  providerNativeCommand: boolean;
  signal: AbortSignal;
  localId: string | null;
  services?: SessionInputDispatchServices;
}>) {
  const services = input.services;
  const compositionScope = createPromptCompositionScope();
  let finalPrompt = '';
  const sessionId = services?.sessionId;
  const attachmentResolver = services?.resolveComposerAttachmentForDispatch;
  const context = await resolveStructuredInputProviderDispatchContext({
    structuredInput: input.prompt.structuredInput,
    sessionMedia: input.prompt.sessionMedia,
    catalogs: services?.catalogs,
    ...(services?.resolveComposerReference ? { composerReferences: {
      resolve: services.resolveComposerReference,
      signal: input.signal,
    } } : {}),
    ...(attachmentResolver && sessionId && input.localId ? { composerAttachments: {
      scope: { kind: 'session' as const, sessionId },
      localId: input.localId,
      signal: input.signal,
      resolve: async (request: Parameters<StructuredInputComposerAttachmentResolver['resolve']>[0]) => {
        try {
          return await attachmentResolver(projectSessionComposerAttachmentDispatchInput(request, sessionId));
        } catch (error) {
          if (isAbortLikeError(error) || error instanceof StructuredInputComposerAttachmentResolutionError) throw error;
          throw new StructuredInputComposerAttachmentResolutionError(
            'composer_attachment_resolution_failed',
            true,
            'Composer attachment resolver failed before provider dispatch',
          );
        }
      },
    } } : {}),
  });
  const renderPrompt = (optionalContext: Pick<Parameters<typeof renderSessionInputContextPromptV1>[0], 'sessionFollowUpdates' | 'workerUpdates'> & {
    runFollowDeliveries?: PermissionModeQueuedPrompt['followDeliveries'];
  } = {}) => {
    const rendered = renderSessionInputContextPromptV1({
      provenanceBlock: input.prompt.inputContextBlock ?? '',
      ...context.promptContext,
      ...optionalContext,
      returnedAnswers: [...input.prompt.returnedAnswerContext ?? [],
        ...(input.prompt.returnedAnswer ? [{ reply: input.prompt.returnedAnswer, text: input.transformedUserText }] : [])],
      transformedUserText: input.providerNativeCommand || input.prompt.returnedAnswer ? '' : input.transformedUserText,
    });
    const runFollowNotices = (optionalContext.runFollowDeliveries ?? []).flatMap(({ delivery }) => 'source' in delivery.original
      ? [`<happier_run_follow>${JSON.stringify({ original: delivery.original,
        ...('event' in delivery ? { event: delivery.event } : {}) }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}</happier_run_follow>\nRead the original Run result.`] : []);
    const nativePrompt = input.providerNativeCommand
      ? [input.transformedUserText, rendered].filter(Boolean).join('\n\n')
      : rendered;
    finalPrompt = [nativePrompt, ...runFollowNotices].filter(Boolean).join('\n');
    return finalPrompt;
  };
  const requiredPrompt = renderPrompt();
  const readComposition = (observation: Readonly<{
    deliveryKind: UsagePromptComposition['deliveryKind']; observedAtMs: number; turnId: string | null;
  }>): UsagePromptComposition | null => {
    if (!sessionId) return null;
    const injected = services?.injectedPromptComponents ?? [];
    const request = services?.modelRequest;
    const selection = request?.readSelection?.() ?? request?.selection;
    const requestIdentity = request && selection ? request.scope.identifyRequest(JSON.stringify([
      finalPrompt, context.structuredInput ? normalizeStrictJsonValue(context.structuredInput) : null,
      request.startupInstructions, request.toolSelection ?? null,
    ]), selection) : undefined;
    return UsagePromptCompositionSchema.parse({ v: 1, evidenceId: randomUUID(), sessionId,
      inputId: input.localId, ...observation, boundary: 'host_pre_dispatch', coverage: 'host_only',
      components: [compositionScope.measure('dispatch-payload', finalPrompt, 'other', 'user',
        injected.length ? 'known' : 'none'), ...injected],
      nativePrefix: null, contextWindowTokens: null, ...(requestIdentity ? { requestIdentity } : {}) });
  };
  const retainComposition = async (observation: Parameters<typeof readComposition>[0]): Promise<void> => {
    if (!services?.retainPromptComposition) return;
    try {
      const composition = readComposition(observation);
      if (composition) await services.retainPromptComposition(composition);
    }
    catch { logger.debug('[Usage composition] Session detail retention unavailable'); }
  };
  return {
    async assertAdmission(): Promise<void> {
      // Context-only input has its own host admission boundary. Every durable
      // protected input must re-enter Pending after arbitrary-duration prompt
      // preparation: materialization into the local queue is custody, not a
      // grant to dispatch an input that has since been discarded.
      if (input.prompt.hostContextOnly || (!input.prompt.discussionAddressing && !input.prompt.causalPermissionAuthority)) return;
      const reconcile = services?.reconcileSessionInputForProviderDispatch;
      const localIds = normalizePermissionModeQueuedPromptLocalIds(input.prompt);
      if (!reconcile || localIds.length === 0) throw new SessionInputDispatchAdmissionError('outcomeUnknown');
      for (const localId of localIds) {
        let status: Awaited<ReturnType<typeof reconcile>>;
        try {
          status = await reconcile({ localId, ...(input.prompt.discussionAddressing
            ? { discussionAddressing: input.prompt.discussionAddressing } : {}), signal: input.signal });
        } catch (error) {
          if (isAbortLikeError(error)) throw error;
          throw new SessionInputDispatchAdmissionError('outcomeUnknown');
        }
        if (status !== 'admitted') throw new SessionInputDispatchAdmissionError(status);
      }
    },
    readComposition,
    retainComposition,
    renderPrompt,
    requiredPrompt,
    requiredProviderContextForBudget: context.structuredInput
      ? `${requiredPrompt}\n${JSON.stringify(context.structuredInput)}`
      : requiredPrompt,
    structuredInput: context.structuredInput ? normalizeStrictJsonValue(context.structuredInput) : undefined,
  };
}

class SessionInputDispatchAdmissionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: 'rejected' | 'held' | 'outcomeUnknown') {
    super('Session input is not currently admitted for provider dispatch');
    this.code = status === 'rejected' ? 'session_input_rejected' : status === 'held' ? 'session_input_held' : 'session_input_admission_unavailable';
    this.retryable = status !== 'rejected';
  }
}

export function readStructuredInputPreparationFailure(error: unknown): Readonly<{ code: string; message: string; retryable: boolean }> | null {
  if (error instanceof SessionInputDispatchAdmissionError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof StructuredInputComposerAttachmentResolutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof StructuredInputComposerReferenceUnavailableError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof StructuredInputSessionMediaProjectionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (
    error instanceof StructuredInputMentionResolutionError
    || error instanceof ResolvedMentionContextTooLargeError
  ) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  return null;
}
