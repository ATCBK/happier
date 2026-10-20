/**
 * Provider-owned ingress ordering. Discord messages for one endpoint retain
 * arrival order, while unrelated endpoints progress independently. Each lane
 * has one in-flight task; pending work has no invented count-based rejection.
 * This does not replace Channels admission/currentness or provider rate limits.
 */

export type DiscordIngressTask<T> = Readonly<{
  connectionId: string;
  endpointId: string;
  signal?: AbortSignal;
  run(signal?: AbortSignal): Promise<T> | T;
}>;

export interface DiscordIngressScheduler {
  schedule<T>(task: DiscordIngressTask<T>): Promise<T>;
}

export class DiscordIngressCancelledError extends Error {
  constructor() {
    super('Discord ingress work was cancelled before it started.');
    this.name = 'DiscordIngressCancelledError';
  }
}

type QueuedTask = Readonly<{
  start(onFinished: () => void): void;
  cancel(): void;
  attachAbortListener(listener: () => void): void;
}>;

type Lane = {
  running: boolean;
  draining: boolean;
  queued: QueuedTask[];
};

function requireIdentifier(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function keyFor(connectionId: string, endpointId: string): string {
  return JSON.stringify([connectionId, endpointId]);
}

function makeQueuedTask<T>(input: DiscordIngressTask<T>): Readonly<{
  promise: Promise<T>;
  task: QueuedTask;
}> {
  let abortListener: (() => void) | undefined;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const detachAbortListener = (): void => {
    if (!abortListener || !input.signal) return;
    input.signal.removeEventListener('abort', abortListener);
    abortListener = undefined;
  };
  const task: QueuedTask = {
    start(onFinished) {
      detachAbortListener();
      if (input.signal?.aborted) {
        rejectPromise(new DiscordIngressCancelledError());
        onFinished();
        return;
      }
      try {
        void Promise.resolve(input.run(input.signal)).then(
          (value) => {
            resolvePromise(value);
            onFinished();
          },
          (error: unknown) => {
            rejectPromise(error);
            onFinished();
          },
        );
      } catch (error) {
        rejectPromise(error);
        onFinished();
      }
    },
    cancel() {
      detachAbortListener();
      rejectPromise(new DiscordIngressCancelledError());
    },
    attachAbortListener(listener) {
      abortListener = listener;
      input.signal?.addEventListener('abort', listener, { once: true });
    },
  };
  return { promise, task };
}

export function createDiscordIngressScheduler(): DiscordIngressScheduler {
  const lanes = new Map<string, Lane>();

  const removeIdleLane = (key: string, lane: Lane): void => {
    if (!lane.running && lane.queued.length === 0) lanes.delete(key);
  };

  const cancelQueuedTask = (key: string, lane: Lane, task: QueuedTask): void => {
    const index = lane.queued.indexOf(task);
    if (index === -1) return;
    lane.queued.splice(index, 1);
    task.cancel();
    removeIdleLane(key, lane);
  };

  const drain = (key: string, lane: Lane): void => {
    if (lane.draining) return;
    lane.draining = true;
    try {
      while (!lane.running && lane.queued.length > 0) {
        const task = lane.queued.shift()!;
        lane.running = true;
        task.start(() => {
          lane.running = false;
          drain(key, lane);
        });
      }
    } finally {
      lane.draining = false;
      removeIdleLane(key, lane);
    }
  };

  return {
    schedule<T>(input: DiscordIngressTask<T>): Promise<T> {
      const connectionId = requireIdentifier(input.connectionId, 'Discord connection ID');
      const endpointId = requireIdentifier(input.endpointId, 'Discord endpoint ID');
      if (input.signal?.aborted) return Promise.reject(new DiscordIngressCancelledError());

      const key = keyFor(connectionId, endpointId);
      const lane = lanes.get(key) ?? { running: false, draining: false, queued: [] };

      const { promise, task } = makeQueuedTask(input);
      lane.queued.push(task);
      lanes.set(key, lane);
      if (input.signal) {
        task.attachAbortListener(() => cancelQueuedTask(key, lane, task));
      }
      drain(key, lane);
      return promise;
    },
  };
}
