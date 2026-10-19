import type { PublicActionInputById, PublicActionResultById } from '../actions/generated.js';
import { HappierActionError, HappierTransportError } from '../errors.js';
import type { ActionExecute, ActionExecutionOptions } from '../types.js';
import { bindPublicActionInput, correspondenceOptions } from './boundActionCall.js';

export type HappierSessionExecutionRunSendInput = Readonly<Omit<
  Extract<PublicActionInputById['session.message.send'], { message: string }>, 'sessionId' | 'message' | 'recipient' | 'wait' | 'reply' | 'returnToSessionId'
>>;
export type HappierSessionExecutionRunHistoryInput = Readonly<Omit<
  PublicActionInputById['session.transcript.get'], 'sessionId' | 'scope' | 'sidechainId' | 'projection'
>>;
export type HappierSessionExecutionRunWaitInput = Readonly<Omit<
  PublicActionInputById['execution.run.wait'], 'sessionId' | 'runId'
>>;

export type HappierSessionExecutionRun<TOptions extends ActionExecutionOptions = ActionExecutionOptions> = Readonly<{
  id: string;
  sessionId: string;
  send: (message: string, input?: HappierSessionExecutionRunSendInput, options?: TOptions) => Promise<PublicActionResultById['session.message.send']>;
  /** Waits for the exact submitted turn through canonical Session admission. */
  sendAndWait: (message: string, input?: HappierSessionExecutionRunSendInput, options?: TOptions) => Promise<PublicActionResultById['session.message.send']>;
  history: (input?: HappierSessionExecutionRunHistoryInput, options?: TOptions) => Promise<PublicActionResultById['session.transcript.get']>;
  /** Observes terminal Run status; an observation timeout does not stop the Run. */
  wait: (input?: HappierSessionExecutionRunWaitInput, options?: TOptions) => Promise<PublicActionResultById['execution.run.wait']>;
  stop: (options?: TOptions) => Promise<PublicActionResultById['execution.run.stop']>;
}>;
export type HappierSessionExecutionRuns<TOptions extends ActionExecutionOptions = ActionExecutionOptions> = Readonly<{
  get: (runId: string) => HappierSessionExecutionRun<TOptions>;
}>;

export function createSessionExecutionRuns<TOptions extends ActionExecutionOptions>(params: Readonly<{
  sessionId: string;
  execute: ActionExecute;
  optionsForSession: (options: TOptions | undefined) => ActionExecutionOptions | undefined;
}>): HappierSessionExecutionRuns<TOptions> {
  const { sessionId, execute, optionsForSession } = params;
  // Caller fields first, bound identity last: an untyped JavaScript object can
  // never retarget the handle's Session, recipient or reply mode.
  const sendInput = (
    runId: string,
    message: string,
    input: HappierSessionExecutionRunSendInput,
    reply: 'none' | 'wait',
    requestId?: string,
  ) => {
    const { wait: _legacyWait, ...fields } = { ...input, wait: undefined };
    return bindPublicActionInput('session.message.send', {
      ...fields, sessionId, message, recipient: { kind: 'execution_run', runId }, reply,
    }, requestId);
  };

  return Object.freeze({
    get: (runId: string): HappierSessionExecutionRun<TOptions> => Object.freeze({
      id: runId,
      sessionId,
      // Every binder is async so a rejected public input reaches the caller the
      // same way an Action failure does, never as a synchronous throw.
      send: async (message, input = {}, options) => await execute(
        'session.message.send',
        sendInput(runId, message, input, 'none', options?.requestId),
        optionsForSession(options),
      ),
      sendAndWait: async (message, input = {}, options) => await execute(
        'session.message.send',
        sendInput(runId, message, input, 'wait', options?.requestId),
        optionsForSession(options),
      ),
      history: async (input = {}, options) => {
        // The bound handle reads its own Run sidechain. The current
        // `externalShareableV1` projection forbids sidechain selection, so a
        // supplied projection is an unsupported combination, not a preference
        // the handle can quietly override.
        if (Object.hasOwn(input, 'projection')) {
          throw new HappierActionError(
            'invalid_parameters',
            'A bound Execution Run reads its own transcript sidechain and cannot select a projection.',
            undefined,
            options?.requestId,
          );
        }
        const routing = optionsForSession(options);
        // `execution.run.get` declares a non-empty `sidechainId`, and the SDK
        // settles every success through that declared output schema. A read
        // that succeeds without a valid current correspondence therefore fails
        // that shared settlement; it is reported as the one typed domain
        // failure the run-history contract names, and no transcript read follows.
        const { run } = await execute(
          'execution.run.get',
          { sessionId, runId },
          correspondenceOptions(routing),
        ).catch((error: unknown) => {
          if (error instanceof HappierTransportError && error.code === 'invalid_action_output') {
            throw new HappierActionError(
              'execution_run_correspondence_unavailable',
              'The Execution Run has no current transcript correspondence.',
              undefined,
              error.requestId,
            );
          }
          throw error;
        });
        return execute('session.transcript.get', bindPublicActionInput('session.transcript.get', {
          ...input, sessionId, scope: 'sidechain', sidechainId: run.sidechainId,
        }, options?.requestId), routing);
      },
      wait: async (input = {}, options) => await execute(
        'execution.run.wait',
        bindPublicActionInput('execution.run.wait', { ...input, sessionId, runId }, options?.requestId),
        optionsForSession(options),
      ),
      stop: async (options) => await execute(
        'execution.run.stop',
        bindPublicActionInput('execution.run.stop', { sessionId, runId }, options?.requestId),
        optionsForSession(options),
      ),
    }),
  });
}
