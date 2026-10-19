let runner: typeof import('vitest') | undefined;
let runnerFailure: unknown;

// The worker marker is only a hint: a node:test subprocess can inherit it
// without inheriting Vitest's runtime state. Admit the runner through its real
// ESM entrypoint, while keeping ordinary public testkit imports runner-neutral.
if (process.env.VITEST_WORKER_ID !== undefined) {
    try {
        runner = await import('vitest');
    } catch (error) {
        runnerFailure = error;
    }
}

export function requireVitestContractRunner(): typeof import('vitest') {
    if (!runner) {
        throw new Error('Agent contract suites require an active Vitest worker.', { cause: runnerFailure });
    }
    return runner;
}
