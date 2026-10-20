import { describe, expect, it } from 'vitest';
import { buildExecutionRunConfiguration } from './openInputs';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createSessionHooksFixture, createTerminalHostFixture } from '../../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { buildCodexAppServerConfigOverrides } from '../../../../../../../../packages/plugins/codex/src/agent/runtime/appServer/config/overrides';

describe('Execution Run tool availability at native launch', () => {
    it.each(['no_tools', 'read_only'] as const)('carries %s through the shared configuration into Claude and Codex', async permissionMode => {
        const { configuration } = buildExecutionRunConfiguration({
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode,
            allowedTools: ['Read', 'WebSearch', 'mcp__docs__*'], unlistedTools: 'ask', updatedAtMs: 1,
        });
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
            { exec: exec.service, sessionHooks: createSessionHooksFixture().service });
        const mcpServers = { docs: { command: 'docs-server', enabledTools: ['read'] } };
        const operations = createClaudeAgentSdkTurnOperations({
            ctx, directory: '/tmp/claude-project', launchEnv: {}, happierSessionId: 'no-tools-run',
            permissionMode: configuration.permissionIntent.value ?? 'default',
            allowedTools: configuration.allowedTools, unlistedTools: configuration.unlistedTools,
            advancedOptions: { tools: ['default'] }, mcpServers,
        });
        try {
            await operations.sendProviderTurnPrompt('Return a text answer');
            const args = exec.spawnClient.mock.calls[0]?.[0].launch.args ?? [];
            const overrides = buildCodexAppServerConfigOverrides(mcpServers, configuration);
            if (permissionMode === 'no_tools') {
                expect(configuration).toMatchObject({ allowedTools: [], unlistedTools: 'deny' });
                expect(args[args.indexOf('--tools') + 1]).toBe('');
                expect(args).toContain('--strict-mcp-config');
                expect(args).not.toContain('--mcp-config');
                expect(overrides).toEqual(expect.arrayContaining(['features.shell_tool=false', 'features.view_image=false', 'web_search="disabled"']));
                expect(overrides.some(value => value.startsWith('mcp_servers.'))).toBe(false);
            } else {
                expect(configuration).toMatchObject({ allowedTools: ['Read', 'WebSearch', 'mcp__docs__*'], unlistedTools: 'ask' });
                expect(args[args.indexOf('--tools') + 1]).toBe('default');
                expect(args).not.toContain('--strict-mcp-config');
                expect(args).toContain('--mcp-config');
                expect(overrides).toContain('mcp_servers.happier__docs.command="docs-server"');
                expect(overrides).not.toContain('features.shell_tool=false');
            }
        } finally { await operations.disposeProviderSession(); }
    });
});
