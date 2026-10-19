import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { fatal: vi.fn(), debug: vi.fn() },
}));

import { registerRunnerTerminationHandlers } from '@/agent/runtime/runnerTerminationHandlers';
import { settleClaudeRunnerLoop } from './claudeRunnerLoopSettlement';

function startRunner() {
    const fakeProcess = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const loopAbort = new AbortController();
    let terminationRequested = false;
    const loop = new Promise<number>((resolve) => {
        loopAbort.signal.addEventListener('abort', () => resolve(0), { once: true });
    });
    const handlers = registerRunnerTerminationHandlers({
        process: fakeProcess,
        exit,
        onTerminationRequested: () => {
            terminationRequested = true;
        },
        // Real runner cleanup aborts the provider loop and awaits it before tearing down.
        onTerminate: async () => {
            loopAbort.abort();
            await loop;
        },
    });
    const settlement = settleClaudeRunnerLoop(loop, {
        isRequested: () => terminationRequested,
        whenTerminated: handlers.whenTerminated,
    });
    return { fakeProcess, exit, loopAbort, handlers, settlement };
}

describe('settleClaudeRunnerLoop', () => {
    it('yields a termination-driven loop exit to the termination owner and its exit code', async () => {
        const runner = startRunner();
        try {
            runner.fakeProcess.emit('uncaughtException', new Error('boom'));

            await expect(runner.settlement).resolves.toEqual({ kind: 'terminated' });
            expect(runner.exit).toHaveBeenCalledTimes(1);
            expect(runner.exit).toHaveBeenCalledWith(1);
        } finally {
            runner.handlers.dispose();
        }
    });

    it('returns an ordinary loop exit to the runner without termination', async () => {
        const runner = startRunner();
        try {
            runner.loopAbort.abort();

            await expect(runner.settlement).resolves.toEqual({ kind: 'completed', value: 0 });
            expect(runner.exit).not.toHaveBeenCalled();
        } finally {
            runner.handlers.dispose();
        }
    });
});
