import { describe, expect, it } from 'vitest';

import { normalizeExecutionRunStartToolInput } from './manualToolContracts';

describe('normalizeExecutionRunStartToolInput', () => {
  it('retains content-free field repair details when run-start tool input is malformed', () => {
    const result = normalizeExecutionRunStartToolInput({ sessionId: 'sess_mcp_1', args: {
      intent: 'review', backendId: 'claude', instructions: { privateRejectedValue: 'private-instructions' },
    } });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [
      { code: 'invalid_type', path: ['instructions'], expected: 'string' },
    ] } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('accepts review execution_run_start requests with a built-in backend target', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        sessionId: 'sess_mcp_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    });

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      }),
    });
  });

  it('accepts review execution_run_start requests with a canonical v2 backend target', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        sessionId: 'sess_mcp_1',
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      },
    });

    expect(result).toEqual({
      ok: true,
      request: expect.objectContaining({
        intent: 'review',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      }),
    });
  });

  // R4-3: the canonical action path (protocol actionExecutor `execution.run.start`) rejects a
  // malformed connected-services selection with `invalid_parameters`. The legacy manual tool must
  // keep the SAME contract — a malformed selection is a bad parameter, not an unparseable payload.
  it('rejects a malformed connected-services selection with invalid_parameters (action-path parity)', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: { v: 999, bindingsByServiceId: 'not-an-object' },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it('forwards a valid connected-services selection into the run-start request', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
          },
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      request: expect.objectContaining({
        connectedServices: expect.objectContaining({
          bindingsByServiceId: expect.objectContaining({
            'happier.agent.codex/openai-codex': expect.objectContaining({ groupId: 'happier' }),
          }),
        }),
      }),
    });
  });

  it('preserves the global native shorthand as an explicit connected-services opt-out', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
        connectedServices: 'native',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      request: expect.objectContaining({ connectedServices: null }),
    });
  });

  it('identifies the missing intent and its declared choices', () => {
    const result = normalizeExecutionRunStartToolInput({
      sessionId: 'sess_mcp_1',
      args: { backendTarget: { kind: 'builtInAgent', agentId: 'claude' } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [
      { code: 'invalid_value', path: ['intent'], acceptedValues: expect.arrayContaining(['review']) },
    ] } });
  });
});
