export type ExecutionRunControllerFailureSignal = Readonly<{
  promise: Promise<never>;
  readError: () => Error | null;
  fail: (error: Error) => void;
}>;

const NEVER_FAILURE_PROMISE = new Promise<never>(() => {});

export function failureSignal(): ExecutionRunControllerFailureSignal {
  let failedError: Error | null = null;
  let rejectFailure!: (error: Error) => void;

  const promise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });

  return {
    promise,
    readError: () => failedError,
    fail(error) {
      if (failedError) {
        return;
      }
      failedError = error;
      rejectFailure(error);
    },
  };
}

export function appendExecutionRunControllerHostBarrier(
  controller: { pendingHostBarrier?: Promise<void>; hostWorkPending?: boolean },
  nextBarrier: Promise<unknown> | (() => Promise<unknown>),
  onSettled?: () => void,
): Promise<void> {
  const startNext = async (): Promise<void> => {
    await (typeof nextBarrier === 'function' ? nextBarrier() : nextBarrier);
  };
  controller.hostWorkPending = true;
  const next = (controller.pendingHostBarrier ? controller.pendingHostBarrier.then(startNext) : startNext()).finally(() => {
    // A later append owns the whole remaining chain. An older completion must
    // neither announce idle nor wake replacement before that work settles.
    if (controller.pendingHostBarrier !== next) return;
    controller.hostWorkPending = false;
    onSettled?.();
  });
  return next;
}

export function readExecutionRunControllerHostBarrier(ctrl: Readonly<{
  pendingHostBarrier?: Promise<void>;
}>): Promise<void> | null {
  return ctrl.pendingHostBarrier ?? null;
}

export async function raceExecutionRunControllerFailure<T>(
  ctrl: Readonly<{
    failureSignal?: ExecutionRunControllerFailureSignal;
  }>,
  task: Promise<T>,
): Promise<T> {
  const failurePromise = ctrl.failureSignal?.promise ?? NEVER_FAILURE_PROMISE;
  return await Promise.race([task, failurePromise]);
}

export function throwIfExecutionRunControllerFailed(ctrl: Readonly<{
  failureSignal?: ExecutionRunControllerFailureSignal;
}>): void {
  const error = ctrl.failureSignal?.readError() ?? null;
  if (error) {
    throw error;
  }
}
