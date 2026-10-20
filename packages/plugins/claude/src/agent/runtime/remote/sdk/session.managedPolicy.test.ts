import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSdkExecFixture, createPluginContextFixture, createTerminalHostFixture, createEventsFixture } from '../../engine.testkit.js';
import { createClaudeAgentSdkTurnOperations } from './session.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import { createClaudeSdkNoResultError } from '../../../sdk/query.js';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ClaudeProviderPromptDeliveryOutcome } from '../../providerOperations.js';

it('preserves a native managed-policy rejection at the public Session boundary without weakening terminal restrictions', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'happier-managed-policy-'));
  const exec = createSdkExecFixture();
  // OS execution reports the native startup refusal; classification and Session
  // outcome projection are real. This does not certify managed-file loading.
  exec.spawnClient.mockRejectedValue(createClaudeSdkNoResultError({ exitCode: 1, signal: null, stdout: '',
    stderr: 'You cannot use --strict-mcp-config when an enterprise MCP config is present' }));
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, { exec: exec.service });
  const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: root,
    launchEnv: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'config') },
    happierSessionId: 'managed-policy', permissionMode: 'read-only', allowedTools: [], unlistedTools: 'deny' });
  const deliveries: ClaudeProviderPromptDeliveryOutcome[] = [];
  operations.setOnPromptDeliveryOutcome(outcome => { deliveries.push(outcome); });
  const runtime = createClaudeNativeSessionRuntimeFromOperations(operations,
    { kind: 'create', sessionId: 'managed-policy', cwd: root }, {
      services: { exec: exec.service },
      session: { services: { activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) } } },
    } as unknown as AgentSessionRuntimeContext);
  try {
    const terminal = await runtime.prepareTerminalPresentation!();
    expect(terminal.kind).toBe('terminal_launch');
    if (terminal.kind !== 'terminal_launch') throw new Error('Expected strict terminal plan');
    expect(terminal.plan.argv).toContain('--strict-mcp-config');
    await expect(runtime.send({ inputIds: ['managed-input'], delivery: { kind: 'newTurn', turnId: 'managed-turn' },
      input: { text: 'No tool effects' } })).resolves.toMatchObject({
        status: 'rejected', retryable: false, diagnostic: { code: 'claude_managed_mcp_policy_conflict' },
      });
    expect(deliveries).toContainEqual(expect.objectContaining({ type: 'input-rejected', retryable: false,
      diagnostic: expect.objectContaining({ code: 'claude_managed_mcp_policy_conflict' }) }));
  } finally {
    await runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
