import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionGoalControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';
import { PluginError } from '@happier-dev/plugin-sdk';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { createCodexNativeSessionControls } from './controls.js';

describe('Codex Goal native failure evidence', () => {
  it('does not reinterpret an initialization refusal as unsupported Goals', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal,
        services: { exec: fixture.exec },
        session: { id: 'happier-session', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [] },
        goalSource: { publish: vi.fn() },
      } as unknown as AgentSessionGoalControlContext);
      expect(result).toMatchObject({ status: 'unavailable', retryable: true,
        diagnostic: { code: 'codex_goal_read_failed', details: { stage: 'initialize', errorCode: '-32600' } } });
    }, { initializeFailure: { code: -32600, message: 'goals feature is disabled' } });
  });

  it.each(['get', 'set', 'clear'] as const)('reports disabled native Goals as unsupported for %s', async operation => {
    // rust-v0.162.1 thread_goal_processor.rs rejects all three methods with
    // this exact error before looking up or resuming the requested thread.
    await withCodexNativeAttachFixture(async fixture => {
      const publish = vi.fn();
      const debug = vi.fn();
      const context = {
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { debug } },
        session: { id: 'happier-session', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [] },
        goalSource: { publish },
      } as unknown as AgentSessionGoalControlContext;
      const goals = createCodexNativeSessionControls().goals;
      const result = operation === 'set'
        ? await goals.set({ objective: 'PRIVATE_TOKEN' }, context)
        : await goals[operation](context);
      expect(result).toMatchObject({ status: 'unsupported',
        diagnostic: { code: 'codex_goals_disabled', details: { stage: `thread/goal/${operation}`, errorCode: '-32600' } },
        goalControlFailure: { phase: 'native_effect' } });
      expect(publish).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN');
    }, { goalFailure: { code: -32600, message: 'goals feature is disabled' } });
  });

  it.each([
    [-32600, 'thread not found: PRIVATE_TOKEN', 'thread_not_found'],
    [-32600, 'ephemeral thread does not support goals: PRIVATE_TOKEN', 'ephemeral_thread'],
    [-32600, 'thread metadata does not match requested id', 'thread_identity_mismatch'],
    [-32600, 'PRIVATE_TOKEN goals feature is disabled', 'unclassified'],
    [-32000, 'goals feature is disabled', 'unclassified'],
  ] as const)('keeps native refusal %s content-free (%s)', async (code, message, condition) => {
    await withCodexNativeAttachFixture(async fixture => {
      const debug = vi.fn();
      const publish = vi.fn();
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal,
        services: { exec: fixture.exec, logger: { debug } },
        session: { id: 'happier-session', cwd: fixture.directory, activity: 'active',
          providerSessionId: 'native-thread', connectedAccounts: [] },
        goalSource: { publish },
      } as unknown as AgentSessionGoalControlContext);
      expect(result).toMatchObject({ status: 'unavailable', retryable: true,
        diagnostic: { code: 'codex_goal_read_failed' }, goalControlFailure: { phase: 'native_effect' } });
      expect(debug.mock.calls.some(([, fields]) => fields?.condition === condition && fields.stage === 'thread/goal/get')).toBe(true);
      expect(JSON.stringify(debug.mock.calls)).not.toContain('PRIVATE_TOKEN');
      expect(publish).not.toHaveBeenCalled();
    }, { goalFailure: { code, message } });
  });

  it('retains a recognized SDK native launch refusal without its private data', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const result = await createCodexNativeSessionControls().goals.get({
        signal: new AbortController().signal,
        services: { exec: { ...fixture.exec, systemTools: { resolve: async () => {
          throw new PluginError({ code: 'plugin_exec_native_launch_unavailable',
            message: 'PRIVATE_TOKEN /private/home', details: { token: 'PRIVATE_TOKEN' } });
        } } } },
        session: { id: 'external-goal', cwd: fixture.directory, activity: 'inactive',
          providerSessionId: 'native-thread', connectedAccounts: [] },
        goalSource: { publish: vi.fn() },
      } as unknown as AgentSessionGoalControlContext);
      expect(result).toMatchObject({ diagnostic: { details: { stage: 'client_creation',
        errorClass: 'PluginError', errorCode: 'plugin_exec_native_launch_unavailable' } } });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|private\/home/);
    });
  });

  it.each(['get', 'set', 'clear'] as const)('retains safe startup, initialize and RPC causes for %s', async operation => {
    for (const stage of ['client_creation', 'initialize', `thread/goal/${operation}`] as const) {
      await withCodexNativeAttachFixture(async fixture => {
        // Process/IPC creation is the external boundary; controls and client stay real.
        const exec = stage === 'client_creation'
          ? { ...fixture.exec, clients: { ...fixture.exec.clients, spawn: async () => {
            throw Object.assign(new TypeError('PRIVATE_TOKEN /private/home goal text'), { code: 'EACCES' });
          } } }
          : fixture.exec;
        const publish = vi.fn();
        const context = {
          signal: new AbortController().signal,
          services: { exec, logger: { debug() {}, warn() {} } },
          session: { id: 'session-goal', cwd: fixture.directory, activity: 'active',
            providerSessionId: 'unpersisted-thread', connectedAccounts: [] },
          goalSource: { publish },
        } as unknown as AgentSessionGoalControlContext;
        const goals = createCodexNativeSessionControls().goals;
        const result = operation === 'set'
          ? await goals.set({ objective: 'PRIVATE_TOKEN goal text' }, context)
          : await goals[operation](context);
        expect(result).toMatchObject({ status: 'unavailable', retryable: true,
          diagnostic: { code: `codex_goal_${operation === 'get' ? 'read' : operation === 'set' ? 'write' : 'clear'}_failed`,
            details: { stage, errorClass: stage === 'client_creation' ? 'TypeError' : 'JsonRpcApplicationError',
              errorCode: stage === 'client_creation' ? 'EACCES' : stage === 'initialize' ? '-32000' : '-32600' } },
          goalControlFailure: { phase: 'native_effect' } });
        if ('diagnostic' in result) expect(AgentRuntimeDiagnosticDataV1Schema.safeParse(result.diagnostic).success).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|private\/home|goal text|unpersisted-thread/);
        expect(publish).not.toHaveBeenCalled();
      }, stage === 'initialize' ? { initializeFailure: { code: -32000, message: 'PRIVATE_TOKEN /private/home goal text' } } : {});
    }
  });
});
