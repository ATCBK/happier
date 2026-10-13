import { describe, expect, it } from 'vitest';
import type { McpServerToolPolicyV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { createExecutionRunPermissionHandler, resolveExecutionRunPermissionDecision } from './executionRunPermissionDecision';

describe('MCP policy for execution runs', () => {
  function fixture(policy: McpServerToolPolicyV1) {
    let current = policy;
    return { change(next: McpServerToolPolicyV1) { current = next; }, getMcpToolContext: () => ({ mcpServerIdentities: { docs: { serverId: 'docs-id', serverTitle: 'Docs' } },
      catalog: { status: 'ready' as const, authority: 'active' as const, revision: 1, diagnostics: [], catalog: { v: 1 as const, bindings: [], servers: [{ id: 'docs-id', name: 'docs', transport: 'stdio' as const, stdio: { command: 'echo', args: [] }, env: {}, createdAt: 1, updatedAt: 1, tools: current }] } } }) };
  }
  it('Off wins over yolo and a listed external tool, while Allow is admitted in default mode', () => {
    const f = fixture({ default: 'ask', overrides: { create: 'off' } });
    const request = { backendId: 'agent', permissionMode: 'yolo', allowedTools: ['mcp__docs__create'], toolName: 'mcp__docs__create', getMcpToolContext: f.getMcpToolContext };
    expect(resolveExecutionRunPermissionDecision(request)).toBe('denied');
    f.change({ default: 'ask', overrides: { create: 'allow' } });
    expect(resolveExecutionRunPermissionDecision({ ...request, permissionMode: 'default', allowedTools: [] })).toBe('approved_for_session');
  });
  it('Ask is interactive even in safe-yolo, and Off is reread before an answer settles', async () => {
    const f = fixture({ default: 'ask', overrides: {} });
    const requests: string[] = [];
    const handler = createExecutionRunPermissionHandler({ backendId: 'agent', permissionMode: 'safe-yolo', getMcpToolContext: f.getMcpToolContext,
      publishPendingRequest: request => { requests.push(request.requestId); } });
    const pending = handler.handleToolCall('pending', 'mcp__docs__create', {});
    expect(requests).toEqual(['pending']);
    f.change({ default: 'ask', overrides: { create: 'off' } });
    expect(handler.respondToPermissionRequest('pending', true)).toBe(true);
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });
});
