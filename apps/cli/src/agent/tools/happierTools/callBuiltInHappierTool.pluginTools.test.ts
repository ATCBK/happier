import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';

const daemonBoundary = vi.hoisted(() => ({
  readCatalog: vi.fn(),
  executeAction: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/daemon/controlClient')>()),
  readDaemonPluginCatalog: daemonBoundary.readCatalog,
  requestDaemonPluginActionExecution: daemonBoundary.executeAction,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: vi.fn(async () => ({
    ok: true,
    sessionId: 'sess-1',
    rawSession: {
      id: 'sess-1',
      metadata: {},
    },
    ctx: { type: 'plain' as const },
    mode: 'plain' as const,
  })),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc: vi.fn(),
}));

import { callBuiltInHappierTool } from './callBuiltInHappierTool';

describe('callBuiltInHappierTool plugin tools', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.clearAllMocks();
    // Home HTTP is the boundary; retain real policy bootstrap's documented
    // unavailable-service cache/default behavior instead of mocking policy.
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('fixture_home_unavailable'));
    const inputSchema = {
      type: 'object',
      properties: { scope: { type: 'string' } },
      additionalProperties: false,
    };
    daemonBoundary.readCatalog.mockResolvedValue({
      kind: 'available',
      plugins: [],
      tools: [{
        toolId: 'acme.review.plugin/review-tool',
        actionId: 'acme.review.plugin/actions/review-start',
        name: 'acme_review_start',
        title: 'Acme Review Start',
        description: 'Start a plugin-defined review workflow',
        inputSchema,
        surfaces: ['agent', 'mcp', 'cli'],
      }],
    });
    // Daemon IPC is the boundary. Placement admission reads a descriptor before
    // dispatch; a completed-effect payload cannot stand in for that reply.
    const actionSpec = ActionDefinitionV1Schema.parse({
      id: 'acme.review.plugin/actions/review-start', title: 'Acme Review Start',
      description: null, safety: 'safe', executionPlacement: 'machine',
      placements: [], slash: null, bindings: null, examples: null, inputHints: null,
      surfaces: { agent: true, mcp: true, cli: true },
      inputSchema,
    });
    daemonBoundary.executeAction.mockImplementation(async (request: { actionId: string }) => ({
      matched: true,
      result: { ok: true, result: request.actionId === 'action.spec.get' ? { actionSpec } : { completed: true } },
    }));
  });

  it('discovers and dispatches a daemon-projected tool through the CLI source entrypoint', async () => {
    const result = await callBuiltInHappierTool({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      toolName: 'acme_review_start',
      args: { scope: 'diff' },
    });

    expect(result).toEqual({
      ok: true,
      result: { completed: true },
    });
    // Placement admission reads the descriptor first; the effect is the last daemon request.
    expect(daemonBoundary.executeAction.mock.calls.at(-1)?.[0]).toEqual({
      actionId: 'acme.review.plugin/review-start',
      input: { scope: 'diff' },
      surface: 'cli',
      defaultSessionId: 'sess-1',
    });
  });
});
