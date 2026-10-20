export type DiagnosticsPullScheduler = Readonly<{
    trigger(path: string): Promise<void>;
    cancel(path: string): void;
    dispose(): void;
}>;

export function createDiagnosticsPullScheduler(options: Readonly<{
    pull(path: string, signal: AbortSignal): Promise<void>;
}>): DiagnosticsPullScheduler {
    type Job = {
        pending: boolean;
        controller: AbortController | null;
        promise: Promise<void>;
    };
    const jobs = new Map<string, Job>();
    let disposed = false;

    async function run(path: string, job: Job): Promise<void> {
        try {
            while (job.pending && !disposed) {
                job.pending = false;
                const controller = new AbortController();
                job.controller = controller;
                try {
                    await options.pull(path, controller.signal);
                } catch (error) {
                    if (!controller.signal.aborted) throw error;
                } finally {
                    job.controller = null;
                }
            }
        } finally {
            if (jobs.get(path) === job) jobs.delete(path);
        }
    }

    function cancel(path: string): void {
        const job = jobs.get(path);
        if (!job) return;
        job.pending = false;
        job.controller?.abort();
    }

    return {
        trigger(path) {
            if (disposed) return Promise.resolve();
            const current = jobs.get(path);
            if (current) {
                current.pending = true;
                current.controller?.abort();
                return current.promise;
            }
            // Defer execution until the job is registered, including synchronous transport failures.
            const job: Job = { pending: true, controller: null, promise: Promise.resolve() };
            jobs.set(path, job);
            job.promise = Promise.resolve().then(() => run(path, job));
            return job.promise;
        },
        cancel,
        dispose() {
            disposed = true;
            for (const path of jobs.keys()) cancel(path);
        },
    };
}
