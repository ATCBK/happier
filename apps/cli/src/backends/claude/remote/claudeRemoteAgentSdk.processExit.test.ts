import type { Query, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeProviderRuntimeActivityAdapter } from '@/backends/claude/providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import { createDeferred } from '@/testkit/async/deferred';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';
import { createClaudeRuntimeActivityEvidence } from './runtimeActivityEvidence';

// The SDK transport and OS process are the boundaries; the ledger, adapter and session
// contribution below remain real so premature task abandonment reaches the publication.
class ControlledProcess extends EventEmitter implements SpawnedProcess {
    stdin = new PassThrough();
    stdout = new PassThrough();
    killed = false;
    pid: number | undefined;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;

    kill() {
        this.killed = true;
        return true;
    }

    exit(signal: NodeJS.Signals | null = null) {
        this.exitCode = signal === null ? 0 : null;
        this.signalCode = signal;
        this.emit('exit', this.exitCode, signal);
        this.stdin.destroy();
        this.stdout.destroy();
    }
}

function runStoppedProcessFixture(child: ControlledProcess, evidence: ReturnType<typeof createClaudeRuntimeActivityEvidence>, launchError?: Error) {
    let didSendPrompt = false;
    return claudeRemoteAgentSdk({
        sessionId: null,
        transcriptPath: null,
        path: '/tmp',
        claudeExecutablePath: '/tmp/claude',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        isAborted: () => false,
        nextMessage: async () => {
            if (didSendPrompt) return null;
            didSendPrompt = true;
            return { message: 'continue', mode: makeMode() };
        },
        onReady: () => {},
        onSessionFound: () => {},
        onMessage: () => {},
        providerRuntimeActivityEvidence: evidence,
        spawnClaudeCodeProcess: () => child,
        createQuery: ({ options }) => {
            const spawnProcess = options?.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess;
            spawnProcess({ command: '/tmp/claude', args: [], env: process.env, signal: new AbortController().signal });
            // SDK process errors reach its query iterator; no exit follows a failed OS spawn.
            child.on('error', () => {});
            if (launchError) child.emit('error', launchError);
            return {
                async *[Symbol.asyncIterator]() {
                    if (launchError) throw launchError;
                },
                close: () => {},
                supportedCommands: async () => [],
                supportedModels: async () => [],
            } as unknown as Query;
        },
    });
}

describe('claudeRemoteAgentSdk owned process exit', () => {
    it.each([false, true])('settles an owned OS child ignoring SIGTERM only when cleanup is verified (OS denies signals: %s)', async (denySignals) => {
        const ready = createDeferred();
        const closeRequested = createDeferred();
        const childCreated = createDeferred<ChildProcess>();
        const evidence = createClaudeRuntimeActivityEvidence();
        const activity = createSessionRuntimeActivity('supported');
        const publish = vi.fn(async () => {});
        await activity.bindPublisher({ publish, close: async () => {} });
        const contributionHandle = activity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime contribution');
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            contributionHandle,
            providerActivityLedger: evidence.providerActivityLedger,
        });
        let didSendPrompt = false;
        const run = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) {
                    await ready.promise;
                    return null;
                }
                didSendPrompt = true;
                return { message: 'background work', mode: makeMode() };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            providerRuntimeActivityEvidence: evidence,
            runtimeActivityAdapter: adapter,
            spawnClaudeCodeProcess: () => {
                const spawnedChild = spawn(process.execPath, [
                    '-e',
                    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
                ], { stdio: 'pipe' });
                return spawnedChild;
            },
            createQuery: ({ options }) => {
                const spawnProcess = options?.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess;
                const controller = options?.abortController as AbortController;
                const owned = spawnProcess({
                    command: process.execPath,
                    args: ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
                    env: process.env,
                    signal: controller.signal,
                });
                if (!(owned instanceof ChildProcess)) throw new Error('Expected real owned OS child');
                childCreated.resolve(owned);
                let stderr = '';
                owned.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
                owned.stdout?.once('data', () => ready.resolve());
                owned.once('exit', (code, signal) => ready.reject(new Error(`Owned OS fixture exited before transport readiness (${code}, ${signal}): ${stderr}`)));
                // The SDK handles AbortError from the OS spawn signal and then closes transport.
                owned.on('error', (error) => {
                    if (!controller.signal.aborted) ready.reject(error);
                });
                controller.signal.addEventListener('abort', () => { owned.kill('SIGTERM'); }, { once: true });
                return {
                    async *[Symbol.asyncIterator]() {
                        await ready.promise;
                        yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                        yield { type: 'system', subtype: 'task_started', session_id: 'owned-session', task_id: 'background-task', task_type: 'local_agent', is_backgrounded: true };
                        yield { type: 'result', subtype: 'success', session_id: 'owned-session' };
                    },
                    // SDK 0.2.123 skips its delayed SIGKILL path once killed is true.
                    close: () => {
                        if (!owned.killed) owned.kill('SIGTERM');
                        closeRequested.resolve();
                    },
                    supportedCommands: async () => [],
                    supportedModels: async () => [],
                } as unknown as Query;
            },
        });
        void run.catch(() => {});
        const child = await Promise.race([childCreated.promise, run.then(() => { throw new Error('SDK query returned before spawn'); })]);
        const signal = process.kill.bind(process);
        // A genuine OS boundary denial restricted to the real process owned by this fixture.
        const denied = denySignals ? vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
            if (pid === child.pid) throw Object.assign(new Error('OS denied owned cleanup'), { code: 'EPERM' });
            return signal(pid, requestedSignal);
        }) : null;
        try {
            await Promise.race([closeRequested.promise, run.then(() => { throw new Error('SDK query returned before close'); })]);
            if (!child.pid) throw new Error('Expected owned child pid');
            expect(child.killed).toBe(true);
            if (denySignals) {
                await expect(run).rejects.toMatchObject({ code: 'process_tree_termination_incomplete' });
                expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
                expect(publish).toHaveBeenLastCalledWith({ state: 'unknown', activeCount: 0 });
            } else {
                await expect(waitForProcessExit(child.pid)).resolves.toBe(true);
                await run;
                expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
                await adapter.publishCurrent('verify-process-exit');
                expect(publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
            }
        } finally {
            denied?.mockRestore();
            if (child && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                if (child.pid) await waitForProcessExit(child.pid);
            }
            await run.catch(() => {});
            await activity.dispose();
        }
    });

    it.each([null, 'SIGTERM'] as const)('settles already-exited owned processes (%s) without waiting for another exit event', async (signal) => {
        const child = new ControlledProcess();
        child.exit(signal);
        const evidence = createClaudeRuntimeActivityEvidence();
        evidence.providerActivityLedger.apply({ type: 'started', sessionId: 's1', taskId: 'old-task' });

        await runStoppedProcessFixture(child, evidence);

        expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
    });

    it('propagates a failed OS spawn without waiting for an exit that cannot arrive or abandoning known tasks', async () => {
        const child = new ControlledProcess();
        child.pid = undefined;
        const launchError = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
        const evidence = createClaudeRuntimeActivityEvidence();
        evidence.providerActivityLedger.apply({ type: 'started', sessionId: 's1', taskId: 'known-task' });
        try {
            await expect(runStoppedProcessFixture(child, evidence, launchError)).rejects.toThrow(launchError);
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
        } finally {
            child.stdin.destroy();
            child.stdout.destroy();
        }
    });

    it('keeps background task evidence and finalization pending until the owned process exits', async () => {
        const child = new ControlledProcess();
        const resultPublished = createDeferred();
        const finishStream = createDeferred();
        const closeRequested = createDeferred();
        const evidence = createClaudeRuntimeActivityEvidence();
        const activity = createSessionRuntimeActivity('supported');
        const publish = vi.fn(async () => {});
        await activity.bindPublisher({ publish, close: async () => {} });
        const contributionHandle = activity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime contribution');
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            contributionHandle,
            providerActivityLedger: evidence.providerActivityLedger,
        });
        let didSendPrompt = false;
        let didReturn = false;
        const run = claudeRemoteAgentSdk({
            sessionId: null,
            transcriptPath: null,
            path: '/tmp',
            claudeExecutablePath: '/tmp/claude',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            nextMessage: async () => {
                if (didSendPrompt) return null;
                didSendPrompt = true;
                return { message: 'start background work', mode: makeMode() };
            },
            onReady: () => {},
            onSessionFound: () => {},
            onMessage: () => {},
            providerRuntimeActivityEvidence: evidence,
            runtimeActivityAdapter: adapter,
            spawnClaudeCodeProcess: () => child,
            createQuery: ({ options }) => {
                const spawnProcess = options?.spawnClaudeCodeProcess as (options: SpawnOptions) => SpawnedProcess;
                spawnProcess({ command: '/tmp/claude', args: [], cwd: '/tmp', env: process.env, signal: new AbortController().signal });
                // The real SDK exposes many unrelated operations. This transport fixture only
                // implements the operations consumed by this lifecycle recipe.
                return {
                    async *[Symbol.asyncIterator]() {
                        yield { type: 'system', subtype: 'init', session_id: 'owned-session' };
                        yield { type: 'system', subtype: 'task_started', session_id: 'owned-session', task_id: 'background-task', task_type: 'local_agent', is_backgrounded: true };
                        yield { type: 'result', subtype: 'success', session_id: 'owned-session' };
                        resultPublished.resolve();
                        await finishStream.promise;
                    },
                    close: () => { closeRequested.resolve(); },
                    supportedCommands: async () => [],
                    supportedModels: async () => [],
                } as unknown as Query;
            },
        });
        void run.then(() => { didReturn = true; }, () => {});

        try {
            await Promise.race([resultPublished.promise, run.then(() => { throw new Error('SDK query returned before result'); })]);
            expect(publish).toHaveBeenLastCalledWith({ state: 'active', activeCount: 1 });
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);

            finishStream.resolve();
            await closeRequested.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);
            expect(publish).toHaveBeenLastCalledWith({ state: 'unknown', activeCount: 0 });
            expect(didReturn).toBe(false);

            child.exit();
            await run;
            await adapter.publishCurrent('verify-process-exit');
            expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
            expect(publish).toHaveBeenLastCalledWith({ state: 'idle', activeCount: 0 });
        } finally {
            finishStream.resolve();
            if (child.exitCode === null) child.exit();
            await run;
            await activity.dispose();
        }
    });
});
