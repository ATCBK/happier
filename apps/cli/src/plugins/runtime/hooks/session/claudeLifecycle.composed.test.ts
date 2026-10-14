import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createSessionHooksService } from './service';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

describe('Claude hook lifecycle composition', () => {
    it('retires a prepared terminal before the first remote turn with real hook ownership', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-claude-hook-composed-'));
        const disposables: Array<{ dispose(): Promise<void> | void }> = [];
        const hooks = createSessionHooksService({ happyHomeDir: home, hasCapability: capability => capability === 'sessionHooks',
            addDisposable: disposable => { disposables.push(disposable); } });
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            exec: exec.service, sessionHooks: hooks,
        });
        const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: home, launchEnv: {},
            permissionMode: 'default', happierSessionId: 'hook-composed' });
        try {
            const terminal = await operations.prepareTerminalPresentation();
            if (terminal.kind !== 'terminal_launch') throw new Error('Expected terminal launch');
            await Promise.all([
                operations.observeTerminalExecution({ kind: 'launch_failed', plan: terminal.plan }),
                ...disposables.splice(0).map(disposable => disposable.dispose()),
            ]);
            operations.beginProviderTurn('first-turn');
            await operations.sendProviderTurnPrompt('Reply ready');
            await exec.emit({ type: 'system', subtype: 'init', session_id: 'native-hook-composed' });
            await exec.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-hook-composed',
                result: 'ready', queued_turn_count: 0, usage: {}, modelUsage: {} });
            await operations.waitForProviderTurnCompletion();
        } finally {
            await operations.disposeProviderSession();
            await Promise.all(disposables.map(disposable => disposable.dispose()));
            await rm(home, { recursive: true, force: true });
        }
    });
});
