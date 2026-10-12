import { describe, expect, it, vi } from 'vitest';

import {
    createEventsFixture,
    createPluginContextFixture,
    createSdkExecFixture,
    createTerminalHostFixture,
} from '../../engine.testkit.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';

describe('Claude SDK turn failure diagnostics', () => {
    it.each(['result', 'provider', 'exit', 'unknown-provider', 'unknown-result', 'signal'] as const)('logs the %s cause without provider text or credentials', async (ending) => {
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            exec: exec.service,
        });
        const operations = createClaudeAgentSdkTurnOperations({
            ctx, directory: '/tmp/claude-diagnostics', launchEnv: {},
            happierSessionId: 'diagnostic-session', permissionMode: 'default',
        });
        const privateText = 'private prompt and provider response';
        const secret = 'synthetic-credential-do-not-log';
        try {
            operations.beginProviderTurn('diagnostic-turn');
            await operations.sendProviderTurnPrompt(privateText);
            await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
            const failed = expect(operations.waitForProviderTurnCompletion()).rejects.toThrow();
            const exited = ending === 'exit' || ending === 'signal';
            if (exited) {
                await exec.exitWith({ exitCode: ending === 'exit' ? 1 : null, signal: ending === 'signal' ? 'SIGTERM' : null,
                    stderr: `${ending === 'exit' ? 'No conversation found with session ID: private-native-id\n' : ''}${privateText}\nANTHROPIC_AUTH_TOKEN=${secret}` });
            } else if (ending === 'provider' || ending === 'unknown-provider') {
                await exec.emit({ type: 'assistant', error: ending === 'provider' ? 'authentication_failed' : `${privateText} ${secret}`, isApiErrorMessage: true,
                    message: { role: 'assistant', content: [{ type: 'text', text: `${privateText} ${secret}` }] } });
            } else {
                await exec.emit({ type: 'result', subtype: ending === 'result' ? 'error_during_execution' : `${privateText} ${secret}`, is_error: true,
                    session_id: 'native-diagnostic', result: `${privateText} ${secret}` });
            }
            await failed;
            expect(ctx.logger.warn).toHaveBeenCalledWith('[ClaudeAgentSdk] Turn failed', expect.objectContaining({
                sessionId: 'diagnostic-session', turnId: 'diagnostic-turn',
                code: exited ? 'claude_sdk_stream_error'
                    : ending === 'provider' ? 'claude_authentication_failed'
                        : ending === 'result' ? 'claude_error_during_execution' : 'Unrecognized failure code (details redacted)',
                sdkResultSubtype: ending === 'result' ? 'error_during_execution'
                    : ending === 'unknown-result' ? 'Unrecognized result subtype (details redacted)' : null,
                processExitObserved: exited,
                exitCode: ending === 'exit' ? 1 : null, signal: ending === 'signal' ? 'SIGTERM' : null,
                stderrSummary: ending === 'exit' ? 'Native resume state not found (details redacted)'
                    : ending === 'signal' ? 'Native stderr present (details redacted)' : null,
            }));
            const logs = JSON.stringify(vi.mocked(ctx.logger.warn).mock.calls);
            expect(logs).not.toContain(privateText);
            expect(logs).not.toContain(secret);
            expect(logs).not.toContain(secret.replaceAll('-', '_'));
            expect(logs).not.toContain('private-native-id');
        } finally {
            await operations.disposeProviderSession();
        }
    });

    it.each(['success', 'cancelled'] as const)('does not label a %s turn as failed', async (ending) => {
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            exec: exec.service,
        });
        const operations = createClaudeAgentSdkTurnOperations({
            ctx, directory: '/tmp/claude-diagnostics', launchEnv: {},
            happierSessionId: 'diagnostic-session', permissionMode: 'default',
        });
        try {
            operations.beginProviderTurn('diagnostic-turn');
            await operations.sendProviderTurnPrompt('private prompt');
            await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
            if (ending === 'cancelled') {
                await operations.cancelProviderTurn();
            } else {
                await exec.emit({ type: 'result', subtype: 'success', is_error: false,
                    session_id: 'native-diagnostic', result: 'private response', num_turns: 1,
                    total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1 });
            }
            await operations.waitForProviderTurnCompletion();
            await operations.disposeProviderSession();
            expect(ctx.logger.warn).not.toHaveBeenCalledWith('[ClaudeAgentSdk] Turn failed', expect.anything());
        } finally {
            await operations.disposeProviderSession();
        }
    });
});
