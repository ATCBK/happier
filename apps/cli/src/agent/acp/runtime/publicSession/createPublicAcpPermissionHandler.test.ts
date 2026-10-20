import { describe, expect, it, vi } from 'vitest';

import { ServerBoundPermissionRpcHandlerManager } from '@/agent/permissions/testkit/serverBoundPermissionRpcHandlerManager';

import type {
  HostCurrentSessionInteractionsService as PluginCurrentSessionInteractionsService,
  HostSessionApprovalRequest as PluginSessionApprovalRequest,
  HostSessionApprovalResult as PluginSessionApprovalResult,
  HostSessionQuestionsRequest,
  HostSessionQuestionsResult,
  HostSessionConfirmationRequest,
  HostSessionConfirmationResult,
  HostSessionInteractionRequest as PluginSessionInteractionRequest,
  HostSessionInteractionResult as PluginSessionInteractionResult,
} from '@/agent/runtime/state/currentSessionUiTypes';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import type { ApiSessionClient } from '@/api/session/sessionClient';

import { createPublicAcpPermissionHandler } from './createPublicAcpPermissionHandler';

type ApprovalRequester = (
  request: PluginSessionApprovalRequest,
  options?: { signal?: AbortSignal },
) => Promise<PluginSessionApprovalResult>;

class TestInteractions implements PluginCurrentSessionInteractionsService {
  constructor(private readonly requestApproval: ApprovalRequester) {}

  request(request: PluginSessionApprovalRequest, options?: { signal?: AbortSignal }): Promise<PluginSessionApprovalResult>;
  request(request: HostSessionQuestionsRequest, options?: { signal?: AbortSignal }): Promise<HostSessionQuestionsResult>;
  request(request: HostSessionConfirmationRequest, options?: { signal?: AbortSignal }): Promise<HostSessionConfirmationResult>;
  async request(
    request: PluginSessionInteractionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PluginSessionInteractionResult> {
    if (request.kind !== 'approval') throw new Error(`Unexpected ${request.kind} interaction`);
    return await this.requestApproval(request, options);
  }
}

function interactions(request: ApprovalRequester): PluginCurrentSessionInteractionsService {
  return new TestInteractions(request);
}

class FakePermissionSession {
  sessionId = 'public-acp-permission-test';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
  } = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: (current: typeof this.agentState) => typeof this.agentState) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return null;
  }
}

describe('createPublicAcpPermissionHandler', () => {
  it.each(['read-only', 'plan'] as const)(
    'preserves the host ACP filesystem effect through the composed native interaction path in %s mode',
    async (permissionMode) => {
      const [{ ProviderEnforcedPermissionHandler }, { createNativeAgentCurrentSessionUiServices }] = await Promise.all([
        import('@/agent/permissions/providerEnforced/handler'),
        import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions'),
      ]);
      const session = createMutableApiSessionClientFixture({ sessionId: 'public-acp-permission-test' });
      const lifetime = new AbortController();
      const hostPermissionHandler = new ProviderEnforcedPermissionHandler(session, { logPrefix: '[PublicAcpPermissionTest]' });
      hostPermissionHandler.setPermissionMode(permissionMode);
      const currentSession = createNativeAgentCurrentSessionUiServices({
        permissionHandler: hostPermissionHandler,
        pluginId: 'happier.agent.test',
        contributionId: 'test',
        runtimeId: 'test',
        sessionId: 'public-acp-permission-test',
        occurrenceId: 'occurrence-1',
        interactionDeadlineMs: 1_000,
        isCurrent: () => true,
        signal: lifetime.signal,
      });
      const handler = createPublicAcpPermissionHandler({
        interactions: currentSession.interactions,
        signal: lifetime.signal,
        resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      });

      try {
        for (const toolName of ['writeTextFile', 'write_file', 'rename', 'delete', 'mkdir']) {
          await expect(handler.handleToolCall(
            `host-fs-write:${toolName}`,
            toolName,
            { path: '/workspace/forbidden.txt', bytes: 9 },
            { origin: 'host_acp_fs_write' },
          )).resolves.toEqual({ decision: 'denied' });
        }
      } finally {
        lifetime.abort();
        await hostPermissionHandler.reset();
        await session.close();
      }
    },
  );

  it('maps an approved session-scoped SVC10 result to ACP session approval', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-1',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'session' as const,
    }));
    const signal = new AbortController().signal;
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    await expect(handler.handleToolCall('call-1', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'approved_for_session',
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'approval',
      allowSessionPersistence: true,
    }), { signal: expect.any(AbortSignal) });
  });

  it('forwards the active turn causal authority unchanged to the canonical interaction owner', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-causal',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const causalPermissionAuthority = Object.freeze({
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveTurnId: () => 'turn-1',
      resolveCausalPermissionAuthority: () => causalPermissionAuthority,
    } as Parameters<typeof createPublicAcpPermissionHandler>[0] & Readonly<{
      resolveCausalPermissionAuthority(toolCallId: string): typeof causalPermissionAuthority | null;
    }>);

    await expect(handler.handleToolCall('call-causal', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'approved',
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval' }), {
      signal: expect.any(AbortSignal),
      permissionContext: { turnId: 'turn-1', causalPermissionAuthority },
    });
  });

  it('fails closed before presentation when the current active turn has no causal authority', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-missing-causal',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveCausalPermissionAuthority: () => null,
    });

    await expect(handler.handleToolCall('call-missing-causal', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'abort',
      rationale: 'ACP permission request causal authority is unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed before presentation when the active turn lacks its host identity', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-missing-turn',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
      resolveTurnId: () => null,
      resolveCausalPermissionAuthority: () => ({
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: 'read-only',
      }),
    });

    await expect(handler.handleToolCall('call-missing-turn', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'abort',
      rationale: 'ACP permission request turn custody is unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed before presentation for invalid JSON and maps unavailable presentation to abort', async () => {
    const request = vi.fn(async () => ({
      requestId: 'interaction-unavailable',
      kind: 'approval' as const,
      status: 'unavailable' as const,
    }));
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    await expect(handler.handleToolCall('call-invalid', 'Bash', { value: undefined })).resolves.toEqual({
      decision: 'abort',
      rationale: 'ACP tool input is not valid bounded JSON',
    });
    expect(request).not.toHaveBeenCalled();

    await expect(handler.handleToolCall('call-unavailable', 'Bash', { command: 'pwd' })).resolves.toEqual({
      decision: 'abort',
    });
  });

  it('aborts the exact in-flight SVC10 request when the ACP turn terminates', async () => {
    let observedSignal: AbortSignal | undefined;
    let interactionSettled = false;
    const request = vi.fn<ApprovalRequester>((_request, options) => {
      observedSignal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          setTimeout(() => {
            interactionSettled = true;
            reject(options.signal?.reason);
          }, 5);
        }, { once: true });
      });
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: interactions(request),
      signal: new AbortController().signal,
      resolveRequestId: (toolCallId) => `turn-1:${toolCallId}`,
    });

    const pending = handler.handleToolCall('call-pending', 'Bash', { command: 'pwd' });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await handler.abortPendingRequestsAndFlush?.('turn ended');

    expect(observedSignal?.aborted).toBe(true);
    expect(interactionSettled).toBe(true);
    await expect(pending).resolves.toEqual(expect.objectContaining({ decision: 'abort' }));
  });

  async function elicitationFixture(
    permissionMode: 'default' | 'yolo' | 'plan' = 'default',
    custody?: Pick<Parameters<typeof createPublicAcpPermissionHandler>[0],
      'resolveRequestId' | 'resolveTurnId' | 'resolveCausalPermissionAuthority'>,
  ) {
    const [{ ProviderEnforcedPermissionHandler }, { createNativeAgentCurrentSessionUiServices }] = await Promise.all([
      import('@/agent/permissions/providerEnforced/handler'),
      import('@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions'),
    ]);
    const session = new FakePermissionSession();
    // The fake replaces the server-backed session transport; permission policy stays real.
    const permissionHandler = new ProviderEnforcedPermissionHandler(session as unknown as ApiSessionClient, {
      logPrefix: '[PublicAcpElicitationTest]',
      getWorkspaceWrites: () => 'allow',
    });
    permissionHandler.setPermissionMode(permissionMode);
    const signal = new AbortController().signal;
    const currentSession = createNativeAgentCurrentSessionUiServices({
      permissionHandler,
      pluginId: 'happier.agent.test',
      contributionId: 'test',
      runtimeId: 'test',
      sessionId: session.sessionId,
      occurrenceId: 'occurrence-1',
      isCurrent: () => true,
      signal,
    });
    const handler = createPublicAcpPermissionHandler({
      interactions: currentSession.interactions,
      signal,
      resolveRequestId: toolCallId => `turn-1:${toolCallId}`,
      resolveTurnId: () => 'turn-1',
      resolveCausalPermissionAuthority: () => ({
        kind: 'admittedSessionInputV1',
        admittedPermissionCeiling: permissionMode,
      }),
      ...custody,
    });
    async function publishedRequest() {
      await vi.waitFor(() => expect(Object.keys(session.agentState.requests)).toHaveLength(1));
      const [id, input] = Object.entries(session.agentState.requests)[0]!;
      return { id, input };
    }
    async function answer(id: string, approved: boolean, answers?: Readonly<Record<string, readonly string[]>>) {
      const respond = session.rpcHandlerManager.handlers.get('session.user_action.answer');
      expect(respond).toBeDefined();
      await expect(respond!({
        id,
        turnId: 'turn-1',
        approved,
        decision: approved ? 'approved' : 'denied',
        ...(answers ? { answers } : {}),
      })).resolves.toBeUndefined();
    }
    return { session, permissionHandler, handler, publishedRequest, answer };
  }

  it('preserves an opaque elicitation tool call identity through turn custody and the real permission interaction', async () => {
    const toolCallId = ' \tcall/工具+=\n ';
    const turnCustody = new Map([[toolCallId, {
      requestId: `acp:${JSON.stringify(['turn-1', toolCallId])}`,
      turnId: 'turn-1',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'default' as const,
      },
    }]]);
    const fixture = await elicitationFixture('default', {
      resolveRequestId: id => turnCustody.get(id)?.requestId ?? null,
      resolveTurnId: id => turnCustody.get(id)?.turnId ?? null,
      resolveCausalPermissionAuthority: id => turnCustody.get(id)?.causalPermissionAuthority ?? null,
    });
    try {
      const pending = fixture.handler.handleElicitation!({
        mode: 'form', sessionId: 'session-1', toolCallId, message: 'Which implementation?',
        requestedSchema: {
          type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
        },
      });
      const request = await fixture.publishedRequest();
      expect(request.input).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action', turnId: 'turn-1' });
      await fixture.answer(request.id, true, { value: ['keep the identity'] });
      await expect(pending).resolves.toEqual({ action: 'accept', content: { value: 'keep the identity' } });
      expect(Object.keys(fixture.session.agentState.requests)).toEqual([]);
    } finally {
      await fixture.permissionHandler.reset();
    }
  });

  it('keeps plan questions pending for an explicit refine answer through the real permission owner', async () => {
    const fixture = await elicitationFixture('plan');
    try {
      const message = '# Plan summary\n' + '- Inspect the ACP adapter.\n'.repeat(25);
      const pending = fixture.handler.handleElicitation!({
        mode: 'form', sessionId: 'session-1', message,
        requestedSchema: {
          type: 'object', properties: {
            value: { type: 'string', oneOf: [
              { const: 'approve', title: 'Approve plan', description: 'Execute the plan' },
              { const: 'refine', title: 'Refine plan', description: 'Keep planning' },
            ] },
          }, required: ['value'],
        },
      });
      const request = await fixture.publishedRequest();
      expect(request.input).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action', turnId: 'turn-1' });
      await fixture.answer(request.id, true, { value: ['refine'] });
      await expect(pending).resolves.toEqual({ action: 'accept', content: { value: 'refine' } });
      expect(Object.keys(fixture.session.agentState.requests)).toEqual([]);
    } finally {
      await fixture.permissionHandler.reset();
    }
  });

  it.each(['default', 'yolo'] as const)('requires explicit confirmation acceptance or decline in %s mode', async (mode) => {
    const fixture = await elicitationFixture(mode);
    try {
      for (const approved of [false, true]) {
        const pending = fixture.handler.handleElicitation!({
          mode: 'form', sessionId: 'session-1', message: 'Continue?',
          requestedSchema: { type: 'object', properties: {} },
        });
        const request = await fixture.publishedRequest();
        expect(request.input).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action' });
        await fixture.answer(request.id, true, { confirmation: [approved ? 'confirm' : 'decline'] });
        await expect(pending).resolves.toEqual(approved
          ? { action: 'accept', content: {} }
          : { action: 'decline' });
      }
    } finally {
      await fixture.permissionHandler.reset();
    }
  });

  it('keeps the actual question visible with long context and accepts ACP nullable schema fields', async () => {
    const fixture = await elicitationFixture();
    try {
      const pending = fixture.handler.handleElicitation!({
        mode: 'form', sessionId: 'session-1', message: 'Plan details. '.repeat(400),
        requestedSchema: { type: 'object', properties: {
          value: { type: 'string', title: 'Which implementation?', enum: ['simple', 'other'] },
        }, required: null },
      });
      const request = await fixture.publishedRequest();
      expect(request.input).toMatchObject({ arguments: { questions: [{ question: expect.stringContaining('Which implementation?') }] } });
      await fixture.answer(request.id, true, { value: ['simple'] });
      await expect(pending).resolves.toEqual({ action: 'accept', content: { value: 'simple' } });
    } finally {
      await fixture.permissionHandler.reset();
    }
  });

  it('retains a cancelled elicitation until explicit Stop and still accepts the next request', async () => {
    const fixture = await elicitationFixture();
    try {
      const controller = new AbortController();
      const input = {
        mode: 'form' as const, sessionId: 'session-1', message: 'Your answer?',
        requestedSchema: { type: 'object' as const, properties: { value: { type: 'string' as const } }, required: ['value'] },
      };
      const pending = fixture.handler.handleElicitation!(input, { signal: controller.signal });
      const request = await fixture.publishedRequest();
      controller.abort();
      await expect(pending).resolves.toEqual({ action: 'cancel' });
      expect(fixture.session.agentState.requests[request.id]).toMatchObject({ tool: 'AskUserQuestion', kind: 'user_action' });
      await fixture.permissionHandler.abortPendingRequestsAndFlush('Explicit person Stop');
      expect(fixture.session.agentState.requests[request.id]).toBeUndefined();
      expect(fixture.session.agentState.completedRequests[request.id])
        .toMatchObject({ status: 'canceled', reason: 'Explicit person Stop' });
      const next = fixture.handler.handleElicitation!(input);
      const nextRequest = await fixture.publishedRequest();
      await fixture.answer(nextRequest.id, true, { value: ['still active'] });
      await expect(next).resolves.toEqual({ action: 'accept', content: { value: 'still active' } });
    } finally {
      await fixture.permissionHandler.reset();
    }
  });
});
