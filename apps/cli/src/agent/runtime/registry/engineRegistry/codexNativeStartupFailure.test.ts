import { describe, expect, it, vi } from 'vitest';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { withCodexNativeAttachFixture } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createCodexSharedAppServer } from '../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/sharedServer';

// Isolate the native OS-user startup lock while retaining its real file-lock behavior.
vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

describe('Codex native startup failure publication', () => {
    it.skipIf(process.platform === 'win32').each([
        { scope: 'session', observed: { kind: 'exit', exitCode: 1 }, nativeExitCode: 1 },
        { scope: 'run', observed: { kind: 'signal', signal: 'SIGKILL' }, nativeSignal: 'SIGKILL' },
    ] as const)('retains sanitized native process termination during $scope startup', async ({ scope, observed, ...termination }) => {
        const sentinel = 'PRIVATE_NATIVE_STDERR_SENTINEL';
        const warn = vi.fn();
        await withCodexNativeAttachFixture(async ({ openConfiguredSession, openConfiguredRun }) => {
            const failure: unknown = await (scope === 'session' ? openConfiguredSession() : openConfiguredRun())
                .then(() => null, error => error);
            const startupFailure = { phase: 'socket_wait', reason: 'process_exited', terminationKind: observed.kind, terminationRequestedBy: 'none',
                ...termination, stderrPresent: true, stderrTruncated: false };
            expect(failure).toMatchObject({ code: 'agent_startup_transport_failed', startupFailure });
            expect(warn).toHaveBeenCalledWith('Codex native startup failed', expect.objectContaining({ startupFailure }));
            expect(String(failure)).toContain('process_exited');
            expect(String(failure)).not.toContain(sentinel);
            expect(JSON.stringify(failure)).not.toContain(sentinel);
            expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
        }, {
            nativeProcessResult: { termination: { observed, requestedBy: { kind: 'none' } },
                stdout: new Uint8Array(), stderr: new TextEncoder().encode(sentinel),
                stdoutTruncated: false, stderrTruncated: false },
            logger: { debug() {}, warn },
            skills: { pluginRoot: '/fixture', skillsRoot: '/fixture/skills', items: [], nativeDisables: [] },
        });
    });

    it.skipIf(process.platform === 'win32')('distinguishes a live process missing its socket from an observed native exit', async () => {
        await withCodexNativeAttachFixture(async ({ exec, directory }) => {
            let finish!: (result: PluginProcessResult) => void;
            const completion = new Promise<PluginProcessResult>(resolve => { finish = resolve; });
            const result: PluginProcessResult = { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'dispose' } },
                stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
            const processEnv = { HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '250', HAPPIER_CODEX_APP_SERVER_STARTUP_RPC_TIMEOUT_MS: '250' };
            const server = await createCodexSharedAppServer({ exec: { ...exec,
                spawn: async () => ({ write: async () => undefined, closeStdin: async () => undefined,
                    onOutput: () => ({ dispose() {} }), wait: async () => completion,
                    dispose: async () => { finish(result); } }),
            }, processEnv, platform: 'linux' });
            try {
                await expect(server?.createClient({ cwd: directory, processEnv, configOverrides: [], disableUserMcpServers: false }))
                    .rejects.toMatchObject({ code: 'agent_startup_transport_failed', startupFailure: { phase: 'socket_wait', reason: 'socket_timeout' } });
            } finally {
                await server?.dispose();
            }
        });
    });
});
