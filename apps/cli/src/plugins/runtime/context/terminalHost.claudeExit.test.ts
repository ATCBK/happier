import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { TerminalHostAdapter } from '@happier-dev/agents';

import { createPluginTerminalHostService } from './terminalHost';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isPidAlive, waitForProcessExit } from '@/testkit/process/spawn';
import { waitForCondition } from '@/testkit/async/waitFor';
import {
    createEventsFixture,
    createPluginContextFixture,
    createSessionHooksFixture,
    createTerminalHostFixture,
    expectRuntimeEnvelope,
} from '../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations.testkit';

describe('Claude unified borrowed-terminal exit composition', () => {
    it.each(['native-close', 'wrapper-killed', 'shell-wrapper-close'] as const)('reconciles %s without another prompt', async (outcome) => {
        if (process.platform === 'win32') return; // Real wrapper-only SIGKILL is a POSIX process boundary.
        const directory = await mkdtemp(join(tmpdir(), 'happier-unified-native-exit-'));
        const readyPath = join(directory, 'ready.json');
        const boundary = createTerminalHostFixture();
        // Only the external terminal host is a fixture: borrowed launch, runner IPC,
        // service ownership and the Claude lifecycle/Activity owners remain real.
        const adapter: TerminalHostAdapter = {
            kind: boundary.handle.kind,
            createOrAttachHost: async () => boundary.handle,
            injectUserPrompt: boundary.service.injectUserPrompt,
            interruptTurn: boundary.service.interruptTurn,
            evaluateLiveness: boundary.service.evaluateLiveness,
            captureInputState: async () => (await boundary.service.captureInputState(boundary.handle))!,
            dispose: async () => undefined,
        };
        const nativeSource = [
            'const fs = require("node:fs");',
            'process.on("SIGTERM", () => process.exit(0));',
            'fs.writeFileSync(process.argv[1], JSON.stringify({ nativePid: process.pid, launcherPid: process.ppid }));',
            'setInterval(() => {}, 1000);',
        ].join('\n');
        const wrapperSource = `require('node:child_process').spawn(process.execPath,
            ['-e', ${JSON.stringify(nativeSource)}, '--', process.argv[1]],
            { stdio: 'ignore', detached: true }).unref(); setInterval(() => {}, 1000);`;
        const host = createPluginTerminalHostService({
            hasCapability: capability => capability === 'terminalHost',
            resolveTerminalHost: () => ({ status: 'resolved', adapter, reason: 'zellij_forced' }),
            resolveAgentCliLaunch: () => ({ command: process.execPath,
                args: ['-e', outcome === 'shell-wrapper-close' ? wrapperSource : nativeSource, '--', readyPath],
                ...(outcome === 'shell-wrapper-close' ? {} : { providerExitOwnership: 'direct' as const }) }),
            resolveCurrentHost: () => ({ handle: boundary.handle, lifecycle: 'borrowed' }),
            disposeHost: async () => undefined,
        });
        const requestingHost: typeof host = outcome === 'shell-wrapper-close' ? {
            ...host,
            createOrAttachHost(request) {
                // Extra public request fields cannot grant host-owned process qualification.
                const forgedRequest = { ...request, providerExitOwnership: 'direct' as const };
                return host.createOrAttachHost(forgedRequest);
            },
        } : host;
        const hooks = createSessionHooksFixture();
        const ctx = createPluginContextFixture(requestingHost, createEventsFixture().service, { sessionHooks: hooks.service });
        const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
            ctx, directory, happierSessionId: 'unified-native-exit', hostPreference: 'zellij',
            launchEnv: { PATH: process.env.PATH ?? '' }, permissionMode: 'default',
        }));
        const runtime = envelope.operations;
        const activity: AgentSessionRuntimeEvent[] = [];
        runtime.subscribeCanonicalAgentSessionEvents(event => activity.push(event));
        let processes: { nativePid: number; launcherPid: number } | undefined;
        try {
            await runtime.startProviderSession();
            await waitForCondition(() => existsSync(readyPath), { timeoutMs: 10_000, label: 'native provider startup' });
            processes = JSON.parse(await readFile(readyPath, 'utf8')) as typeof processes;
            const request = hooks.service.startServer.mock.calls[0]?.[0];
            if (!request?.onSessionHook) throw new Error('Session hook boundary was not started');
            await request.onSessionHook('native-exit-provider-session', {
                hook_event_name: 'PostToolUse', session_id: 'native-exit-provider-session', tool_name: 'Agent',
                tool_response: { status: 'async_launched', agentId: 'agent-active-at-exit' },
            });
            await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({ state: 'active', activeCount: 1 }));
            if (outcome === 'native-close') {
                process.kill(processes!.nativePid, 'SIGTERM');
                await expect(waitForProcessExit(processes!.nativePid, { timeoutMs: 10_000 })).resolves.toBe(true);
            } else {
                process.kill(processes!.launcherPid, outcome === 'shell-wrapper-close' ? 'SIGTERM' : 'SIGKILL');
                await expect(waitForProcessExit(processes!.launcherPid, { timeoutMs: 10_000 })).resolves.toBe(true);
                expect(isPidAlive(processes!.nativePid)).toBe(true);
            }
            await vi.waitFor(() => expect(activity.at(-1)).toMatchObject({
                kind: 'runtime-activity-snapshot', state: outcome === 'native-close' ? 'idle' : 'unknown', activeCount: 0,
            }));
            if (outcome === 'native-close') {
                // The real hook forwarder can finish before server publication delivers its callback.
                await request.onSessionHook('native-exit-provider-session', {
                    hook_event_name: 'SessionEnd', session_id: 'native-exit-provider-session',
                });
                expect(activity.at(-1)).toMatchObject({ state: 'idle', activeCount: 0 });
            }
        } finally {
            // Never strand a fixture provider after intentionally killing only its wrapper.
            if (!processes && existsSync(readyPath)) processes = JSON.parse(await readFile(readyPath, 'utf8')) as typeof processes;
            if (processes?.nativePid && isPidAlive(processes.nativePid)) await terminateProcessTree({ pid: processes.nativePid });
            if (processes?.launcherPid && isPidAlive(processes.launcherPid)) await terminateProcessTree({ pid: processes.launcherPid });
            await runtime.resetOrDisposeRuntime().catch(() => undefined);
            await rm(directory, { recursive: true, force: true });
        }
    });
});
