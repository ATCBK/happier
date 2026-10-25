import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI } from '@/mcp/resources/registerHappierMcpResources';
import { createExternalMcpServer as createExternalMcpServerStatic } from '@/mcp/createExternalMcpServer';

const env = process.env;

function isStartExecutionRun(value: unknown): value is (sessionId: string, request: unknown) => Promise<unknown> {
  return typeof value === 'function';
}

describe('createExternalMcpServer', () => {
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('returns toolNames aligned with per-surface action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'execution.run.list': { enabled: true, disabledSurfaces: ['mcp'], disabledPlacements: [] },
      },
    });

    const { toolNames } = createExternalMcpServerStatic({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(toolNames).not.toContain('execution_run_list');
  });

  it('advertises server-backed Session Actions only from enabled exact-Home feature snapshots', () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({ v: 1, actions: {
      'discussion.list': { toolExposureModes: { mcp: 'direct' } },
    } });
    const credentials = {
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };
    const snapshot = (enabled: boolean) => ({
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, board: { enabled }, conversations: { enabled } }, sharing: { enabled: true, session: { enabled: true } } },
        capabilities: {},
      }),
    });

    // Board item reads also serve transcript visuals; only layout mutations
    // depend on Board availability.
    expect(createExternalMcpServerStatic({ credentials }).toolNames).toContain('session_board_get');
    expect(createExternalMcpServerStatic({ credentials, serverFeaturesSnapshot: snapshot(false) }).toolNames).toContain('session_board_get');
    expect(createExternalMcpServerStatic({ credentials, serverFeaturesSnapshot: snapshot(true) }).toolNames).toContain('session_board_get');
    expect(createExternalMcpServerStatic({ credentials }).toolNames).not.toContain('discussion_list');
    expect(createExternalMcpServerStatic({ credentials, serverFeaturesSnapshot: snapshot(false) }).toolNames).not.toContain('discussion_list');
    expect(createExternalMcpServerStatic({ credentials, serverFeaturesSnapshot: snapshot(true) }).toolNames).toContain('discussion_list');
  });

  it('registers action-spec resources for the mcp surface', async () => {
    const { mcp, toolNames } = createExternalMcpServerStatic({
      credentials: { token: 'token', encryption: null },
    });
    const client = new Client({ name: 'external-resource-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(toolNames).toContain('watch');
      const resource = await client.readResource({ uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI });
      const content = resource.contents[0];
      if (!content || !('text' in content) || typeof content.text !== 'string') throw new Error('Missing Action catalog resource');
      const catalog: { actionSpecs: Array<{ id: string }> } = JSON.parse(content.text);
      expect(catalog.actionSpecs.map(spec => spec.id)).toContain('session.target.primary.set');
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it('uses the canonical plain Session crypto context for token-only credentials', async () => {
    vi.resetModules();

    let capturedHarnessParams: Record<string, unknown> | null = null;
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>) => {
        capturedHarnessParams = params;
        return {
          executor: {
            execute: async () => ({ ok: false, errorCode: 'not_implemented' }),
          },
        };
      },
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');
    const credentials = {
      token: 'plain-token',
      encryption: null,
    } as const;

    createExternalMcpServer({ credentials });

    expect(capturedHarnessParams).toMatchObject({
      credentials,
      token: 'plain-token',
      mode: 'plain',
      ctx: null,
    });
  });

  it('gives the shared Account server adapter the exact E2EE credential for public-link materialization', async () => {
    vi.resetModules();

    let capturedAccountServerInput: Record<string, unknown> | null = null;
    let capturedDiscussionInput: Record<string, unknown> | null = null;
    let capturedFollowInput: Record<string, unknown> | null = null;
    let capturedHarnessParams: Record<string, unknown> | null = null;
    vi.doMock('@/api/accountServerActionDeps', () => ({
      createAccountServerActionDeps: (input: Record<string, unknown>) => {
        capturedAccountServerInput = input;
        return {};
      },
    }));
    vi.doMock('@/discussions/discussionActionDeps', () => ({
      createDiscussionActionDeps: (input: Record<string, unknown>) => {
        capturedDiscussionInput = input;
        return { discussionAction: vi.fn() };
      },
    }));
    vi.doMock('@/api/sessionFollowActionDeps', () => ({
      createSessionFollowActionDeps: (input: Record<string, unknown>) => {
        capturedFollowInput = input;
        return { sessionFollowAction: vi.fn() };
      },
    }));
    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: (params: Record<string, unknown>) => {
        capturedHarnessParams = params;
        return {
          executor: { execute: async () => ({ ok: false, errorCode: 'not_implemented' }) },
        };
      },
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');
    const credentials = {
      token: 'e2ee-token',
      encryption: {
        type: 'dataKey' as const,
        publicKey: new Uint8Array(32).fill(2),
        machineKey: new Uint8Array(32).fill(3),
      },
    };

    const serverFeaturesSnapshot = {
      status: 'ready' as const,
      provenance: 'authenticated' as const,
      features: FeaturesResponseSchema.parse({
        features: {},
        capabilities: { serverIdentity: { serverIdentityId: 'srv_stable-home-identity' } },
      }),
    };
    createExternalMcpServer({ credentials, machineId: 'machine-current', serverFeaturesSnapshot });

    expect(capturedAccountServerInput).toMatchObject({
      token: credentials.token,
      credentials,
      resolveServerFeaturesSnapshot: expect.any(Function),
      serverIdentityId: 'srv_stable-home-identity',
    });
    expect(capturedDiscussionInput).toMatchObject({ credentials, serverIdentityId: 'srv_stable-home-identity' });
    expect(capturedFollowInput).toMatchObject({
      token: credentials.token,
      serverIdentityId: 'srv_stable-home-identity',
      prepareSourceKeyAfterSet: expect.any(Function),
    });
    expect(capturedHarnessParams).toMatchObject({ serverIdentityId: 'srv_stable-home-identity' });
  });

  it('passes through approval_request_created for execution_run_start tool calls via the shared action executor', async () => {
    vi.resetModules();

    let capturedExecuteActionByToolName: unknown = null;

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: any, params: any) => {
        capturedExecuteActionByToolName = params?.deps?.executeActionByToolName ?? null;
        return { toolNames: [] };
      },
    }));

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: async (actionId: string) => ({
            ok: true,
            result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
          }),
        },
      }),
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');

    createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(typeof capturedExecuteActionByToolName).toBe('function');

    if (!capturedExecuteActionByToolName) {
      throw new Error('expected executeActionByToolName to be registered');
    }

    if (typeof capturedExecuteActionByToolName !== 'function') {
      throw new Error('expected executeActionByToolName to be callable');
    }

    const res = await capturedExecuteActionByToolName('action_execute', { actionId: 'execution.run.start', input: {
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      instructions: 'Review.',
    } }, 'sess-1');

    expect(res).toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'execution.run.start' },
    });
  });

  it('passes through approval_request_created for change_title tool calls', async () => {
    vi.resetModules();

    let capturedChangeTitle: unknown = null;

    vi.doMock('@/mcp/server/registerHappierMcpBuiltInTools', () => ({
      registerHappierMcpBuiltInTools: (_server: any, params: any) => {
        capturedChangeTitle = params?.deps?.changeTitle ?? null;
        return { toolNames: [] };
      },
    }));

    vi.doMock('@/session/actions/createCliActionExecutorHarness', () => ({
      createCliActionExecutorHarness: () => ({
        executor: {
          execute: async (actionId: string) => ({
            ok: true,
            result: { kind: 'approval_request_created', artifactId: 'a1', actionId },
          }),
        },
      }),
    }));

    const { createExternalMcpServer } = await import('@/mcp/createExternalMcpServer');

    createExternalMcpServer({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
    });

    expect(typeof capturedChangeTitle).toBe('function');
    if (!capturedChangeTitle || typeof capturedChangeTitle !== 'function') {
      throw new Error('expected changeTitle to be registered');
    }

    const res = await (capturedChangeTitle as (sessionId: string, title: string) => Promise<unknown>)(
      'sess-1',
      'hello',
    );

    expect(res).toEqual({
      kind: 'approval_request_created',
      artifactId: 'a1',
      actionId: 'session.title.set',
    });
  });

});
