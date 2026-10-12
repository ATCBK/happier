import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState } from '@/api/types';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';
import { createNativeAgentSessionServices } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';

import type { DisposableCodexAppServerClient } from './client.js';
import { registerCodexAppServerInteractionHandlers } from './interactions.js';

// Session state and authenticated RPC transport are the system boundaries; all
// interaction normalization, grant storage, and permission decisions stay real.
class ApprovalSession {
  readonly sessionId = 'session-approval-subject';
  readonly rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  state: AgentState = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() { return this.state; }
  getMetadataSnapshot() { return null; }
  updateAgentState(update: (state: AgentState) => AgentState) {
    this.state = update(this.state);
    return this.state;
  }
  async getAuthenticatedAccountId() { return 'account-owner'; }
}

function createFixture() {
  const session = new ApprovalSession();
  const permissionHandler = createProviderEnforcedPermissionHandler({
    session: session as unknown as ApiSessionClient,
    logPrefix: '[CodexApprovalSubjectTest]',
    // The host has admitted a writable session; tool grants still require approval.
    getWorkspaceWrites: () => 'allow',
  });
  const controller = new AbortController();
  const services = createNativeAgentSessionServices({
    permissionHandler,
    pluginId: 'happier.codex',
    contributionId: 'codex',
    runtimeId: 'codex/runtime',
    sessionId: session.sessionId,
    occurrenceId: 'codex-occurrence',
    immutableGenerationId: 'codex-generation',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'codex-generation', installSource: 'npm' },
    isCurrent: () => true,
    signal: controller.signal,
  });
  const requests = new Map<string, Parameters<DisposableCodexAppServerClient['registerRequestHandler']>[1]>();
  const notifications = new Map<string, Set<(params: unknown) => void>>();
  const client: DisposableCodexAppServerClient = {
    request: vi.fn(async () => ({})),
    notify: vi.fn(async () => {}),
    registerRequestHandler(method, handler) {
      requests.set(method, handler);
      return () => requests.delete(method);
    },
    registerNotificationHandler(method, handler) {
      const handlers = notifications.get(method) ?? new Set();
      handlers.add(handler);
      notifications.set(method, handlers);
      return () => handlers.delete(handler);
    },
    onExit: () => () => {},
    dispose: vi.fn(async () => {}),
  };
  registerCodexAppServerInteractionHandlers({ client, ui: services.interactions, getThreadId: () => 'thread-1' });
  const publish = (method: string, raw: unknown) => {
    for (const handler of notifications.get(method) ?? []) handler(raw);
  };
  return {
    session,
    stop: () => controller.abort(),
    publish,
    request(itemId: string, source?: { server: string; tool: string }) {
      if (source) publish('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { id: itemId, type: 'mcpToolCall', ...source, arguments: {} },
      });
      const handler = requests.get('item/tool/requestUserInput');
      if (!handler) throw new Error('Missing Codex tool input handler');
      return Promise.resolve(handler({
        threadId: 'thread-1', turnId: 'turn-1', itemId,
        questions: [{
          id: 'mcp_tool_call_approval_1', header: 'Approval', question: 'Allow this MCP tool call?',
          isOther: false, isSecret: false,
          options: [
            { label: 'Approve Once', description: 'Run once' },
            { label: 'Approve this Session', description: 'Run for this session' },
            { label: 'Deny', description: 'Do not run' },
          ],
        }],
      }, { id: `rpc-${itemId}` }));
    },
    async pending() {
      await vi.waitFor(() => expect(Object.keys(session.state.requests ?? {})).toHaveLength(1));
      const entry = Object.entries(session.state.requests ?? {})[0]!;
      return { id: entry[0], request: entry[1] };
    },
    async respond(id: string, decision: 'approved_for_session' | 'denied') {
      const respond = session.rpcHandlerManager.handlers.get('permission');
      if (!respond) throw new Error('Missing authenticated permission RPC handler');
      await respond({ id, approved: decision === 'approved_for_session', decision });
    },
  };
}

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
const approvedAnswer = { answers: { mcp_tool_call_approval_1: { answers: ['Approve this Session'] } } };
const deniedAnswer = { answers: { mcp_tool_call_approval_1: { answers: ['Deny'] } } };

describe('Codex MCP approval subjects through real session grants', () => {
  it('keeps a grant on one server/tool from approving a different tool or server', async () => {
    const fixture = createFixture();
    stops.push(fixture.stop);
    const first = fixture.request('call-a', { server: 'deployment', tool: 'create' });
    const pendingA = await fixture.pending();
    await fixture.respond(pendingA.id, 'approved_for_session');
    await expect(first).resolves.toEqual(approvedAnswer);

    const second = fixture.request('call-b', { server: 'deployment', tool: 'delete' });
    const pendingB = await fixture.pending();
    expect(pendingB.request.tool).toBe('mcp__deployment__delete');
    await fixture.respond(pendingB.id, 'denied');
    await expect(second).resolves.toEqual(deniedAnswer);

    const third = fixture.request('call-c', { server: 'other', tool: 'create' });
    const pendingC = await fixture.pending();
    expect(pendingC.request.tool).toBe('mcp__other__create');
    await fixture.respond(pendingC.id, 'denied');
    await expect(third).resolves.toEqual(deniedAnswer);

    expect(pendingA.request.tool).toBe('mcp__deployment__create');
    await expect(fixture.request('call-a-again', { server: 'deployment', tool: 'create' })).resolves.toEqual(approvedAnswer);
    expect(Object.keys(fixture.session.state.requests ?? {})).toHaveLength(0);
  });

  it('gives approvals without an MCP item a distinct subject for each call', async () => {
    const fixture = createFixture();
    stops.push(fixture.stop);
    const first = fixture.request('unknown-a');
    const pendingA = await fixture.pending();
    await fixture.respond(pendingA.id, 'approved_for_session');
    await expect(first).resolves.toEqual(approvedAnswer);
    const second = fixture.request('unknown-a');
    const pendingB = await fixture.pending();
    expect(pendingB.request.tool).not.toBe(pendingA.request.tool);
    await fixture.respond(pendingB.id, 'denied');
    await expect(second).resolves.toEqual(deniedAnswer);
  });

  it('ignores another thread and forgets completed item identities', async () => {
    const fixture = createFixture();
    stops.push(fixture.stop);
    fixture.publish('item/started', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'reused-item', type: 'mcpToolCall', server: 'deployment', tool: 'create' },
    });
    fixture.publish('item/started', {
      threadId: 'other-thread', turnId: 'turn-1',
      item: { id: 'reused-item', type: 'mcpToolCall', server: 'other', tool: 'delete' },
    });
    const first = fixture.request('reused-item');
    const pendingA = await fixture.pending();
    expect(pendingA.request.tool).toBe('mcp__deployment__create');
    await fixture.respond(pendingA.id, 'approved_for_session');
    await expect(first).resolves.toEqual(approvedAnswer);

    fixture.publish('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reused-item', type: 'mcpToolCall' },
    });
    const second = fixture.request('reused-item');
    const pendingB = await fixture.pending();
    expect(pendingB.request.tool).not.toBe(pendingA.request.tool);
    await fixture.respond(pendingB.id, 'denied');
    await expect(second).resolves.toEqual(deniedAnswer);
  });
});
