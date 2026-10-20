import { describe, expect, it } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { openCodexNativeAppServerSession } from './native.js';

const configuration = {
  mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
  permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {},
  allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny',
} as const;

describe('Codex tool restriction launch boundaries', () => {
  it('refuses a proxy whose already-running server cannot receive the confinement overrides', async () => {
    // The refusal must precede any process/host service access.
    const unavailableContext = {} as AgentSessionRuntimeContext;
    await expect(openCodexNativeAppServerSession({
      kind: 'resume', sessionId: 'restricted', cwd: '/workspace', providerSessionId: 'thread-1',
      configuration,
      runtimeDescriptorV1: {
        v: 1, agentId: 'codex', agent: {
          backendMode: 'appServer', providerSessionId: 'thread-1', appServerTransport: 'daemonProxy',
        },
      },
    }, unavailableContext)).rejects.toMatchObject({ code: 'codex_tool_restriction_unsupported_transport' });
  });

});
