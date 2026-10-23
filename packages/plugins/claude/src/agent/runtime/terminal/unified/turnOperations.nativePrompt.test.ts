import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture, expectRuntimeEnvelope } from '../../engine.testkit.js';
import { createFakeControlPort } from './tuiControls/fakeControlPort.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.testkit.js';

const QUESTION = { question: 'Which probe color?', header: 'Header Color', multiSelect: false,
  options: [{ label: 'Amber', description: 'Warm amber probe color.' }, { label: 'Blue', description: 'Cool blue probe color.' }] };
const SCREEN = readFileSync(new URL('./tuiControls/__fixtures__/claude-2.1.304-question-single.txt', import.meta.url), 'utf8');

describe('Claude native prompt hook delivery', () => {
  it.each([
    { hookEvent: 'PostToolUse', sessionId: 'native-plan', sidechain: false, preViaPermissionHook: false, clears: true },
    { hookEvent: 'PostToolUse', sessionId: 'native-plan', sidechain: false, preViaPermissionHook: true, clears: true },
    { hookEvent: 'PostToolUseFailure', sessionId: 'native-plan', sidechain: false, preViaPermissionHook: false, clears: false },
    { hookEvent: 'PostToolUse', sessionId: 'foreign-plan', sidechain: false, preViaPermissionHook: false, clears: false },
    { hookEvent: 'PostToolUse', sessionId: 'native-plan', sidechain: true, preViaPermissionHook: false, clears: false },
  ])('preserves saved mode continuity after native $hookEvent (session=$sessionId, sidechain=$sidechain, nativePrompt=$preViaPermissionHook)', async ({ hookEvent, sessionId, sidechain, preViaPermissionHook, clears }) => {
    const terminalHost = createTerminalHostFixture();
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service);
    let selectedMode: string | null = 'plan';
    const withModes = { ...ctx, agentRuntime: { ...ctx.agentRuntime,
      toolExecution: { before: async (call: { input: Record<string, unknown> }) => ({ status: 'continue' as const, input: call.input }) },
      modes: {
      bind: () => ({ dispose() {} }),
      complete: async ({ modeId }: Readonly<{ modeId: string }>) => {
        if (selectedMode === modeId) selectedMode = null;
      },
    } } };
    vi.mocked(terminalHost.service.controlPort).mockResolvedValue(createFakeControlPort({ captures: ['❯ '] }));
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx: withModes, directory: '/tmp/claude-project', happierSessionId: 'native-plan-session',
      hostPreference: 'zellij', launchEnv: {}, permissionMode: 'plan',
    }));
    try {
      await envelope.operations.startProviderSession();
      const ingress = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]![0];
      const tool = { session_id: 'native-plan', tool_use_id: 'plan-1', tool_name: 'ExitPlanMode', tool_input: {} };
      if (preViaPermissionHook) {
        await ingress.onPermissionHook!({ ...tool, hook_event_name: 'PreToolUse' });
      } else {
        await ingress.onSessionHook!('native-plan', { ...tool, hook_event_name: 'PreToolUse' });
      }
      await ingress.onSessionHook!('native-plan', { ...tool, hook_event_name: hookEvent, session_id: sessionId, ...(sidechain ? { agent_id: 'child-plan' } : {}) });
      expect(selectedMode).toBe(clears ? null : 'plan');
    } finally {
      await envelope.operations.resetOrDisposeRuntime();
    }
  });

  it.each([
    { decision: 'accept', sessionId: 'native-plan', sidechain: false, parentField: null, clears: true },
    { decision: 'reject', sessionId: 'native-plan', sidechain: false, parentField: null, clears: false },
    { decision: null, sessionId: 'native-plan', sidechain: false, parentField: null, clears: false },
    { decision: 'accept', sessionId: 'foreign-plan', sidechain: false, parentField: null, clears: false },
    { decision: 'accept', sessionId: 'native-plan', sidechain: true, parentField: null, clears: false },
    { decision: 'accept', sessionId: 'native-plan', sidechain: false, parentField: 'parent_tool_use_id', clears: false },
    { decision: 'accept', sessionId: 'native-plan', sidechain: false, parentField: 'parentToolUseId', clears: false },
  ])('completes only exact native raw Plan acceptance (decision=$decision, session=$sessionId, sidechain=$sidechain)', async ({ decision, sessionId, sidechain, parentField, clears }) => {
    const terminalHost = createTerminalHostFixture();
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service);
    let selectedMode: string | null = 'plan';
    const withModes = { ...ctx, agentRuntime: { ...ctx.agentRuntime, modes: {
      bind: () => ({ dispose() {} }),
      complete: async ({ modeId }: Readonly<{ modeId: string }>) => {
        if (selectedMode === modeId) selectedMode = null;
      },
    } } };
    vi.mocked(terminalHost.service.controlPort).mockResolvedValue(createFakeControlPort({ captures: ['❯ '] }));
    const operations = createClaudeUnifiedTerminalTurnOperations({
      ctx: withModes, directory: '/tmp/claude-project', happierSessionId: 'native-plan-session',
      hostPreference: 'zellij', launchEnv: {}, permissionMode: 'plan', nativeOperationsOnly: true,
    });
    const directory = await mkdtemp(join(tmpdir(), 'native-plan-continuity-'));
    const transcriptPath = join(directory, 'native.jsonl');
    await writeFile(transcriptPath, JSON.stringify({ type: 'user', uuid: 'initial-user', sessionId: 'native-plan',
      message: { role: 'user', content: 'Review the plan' } }) + '\n');
    try {
      await operations.startProviderSession();
      const ingress = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]![0];
      await ingress.onSessionHook!('native-plan', { hook_event_name: 'SessionStart', session_id: 'native-plan', source: 'startup', transcript_path: transcriptPath });
      await vi.waitFor(() => expect(ctx.agentRuntime.transcripts.followSource).toHaveBeenCalled());
      await ingress.onSessionHook!('native-plan', { session_id: 'native-plan', tool_use_id: 'plan-1',
        tool_name: 'ExitPlanMode', tool_input: {}, hook_event_name: 'PreToolUse' });
      await operations.observeSourceTranscript({ providerSessionId: 'native-plan', sourceId: 'native-plan-result', row: {
        uuid: 'native-plan-result', sessionId, isSidechain: sidechain, type: 'user',
        ...(parentField ? { [parentField]: 'child-tool' } : {}),
        ...(decision ? { permissionDecision: { decision } } : {}),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'plan-1', is_error: true, content: 'Plan response' }] },
      } });
      expect(selectedMode).toBe(clears ? null : 'plan');
    } finally {
      await operations.resetOrDisposeRuntime();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('keeps missing-ID app permissions scoped to their live producer (sidechain: %s)', async (sidechain) => {
    const terminalHost = createTerminalHostFixture();
    const requestDecision = vi.fn<SessionPermissionsService['requestDecision']>((_request, options) => new Promise(resolve => {
      options?.signal?.addEventListener('abort', () => resolve({ decision: 'abort' }), { once: true });
    }));
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service, {
      sessionPermissions: { requestDecision, getMode: () => 'default' },
      toolExecution: { before: async (call: { input: Record<string, unknown> }) => ({ status: 'continue', input: call.input }) },
    });
    vi.mocked(terminalHost.service.controlPort).mockResolvedValue(createFakeControlPort({ captures: ['❯ '] }));
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx, directory: '/tmp/claude-project', happierSessionId: 'app-hook-identity', hostPreference: 'zellij',
      launchEnv: {}, permissionMode: 'default', responseLocations: { question: 'app_only', permission: 'app_only' },
    }));
    const abort = new AbortController();
    try {
      await envelope.operations.startProviderSession();
      const hooks = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]![0];
      const data = { session_id: 'native-session', tool_name: 'Bash', tool_input: { command: 'echo same' } };
      await hooks.onSessionHook!('native-session', { ...data, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-old' });
      await hooks.onSessionHook!('native-session', { ...data, hook_event_name: 'PostToolUse', tool_use_id: 'toolu-old' });
      await hooks.onSessionHook!('native-session', { ...data, hook_event_name: 'PreToolUse', tool_use_id: 'toolu-current' });
      const hook = Promise.resolve(hooks.onPermissionHook!({ ...data, hook_event_name: 'PermissionRequest',
        ...(sidechain ? { agent_id: 'child-agent' } : {}),
      }, { signal: abort.signal }));
      try {
        await vi.waitFor(() => expect(requestDecision).toHaveBeenCalled());
        const request = requestDecision.mock.calls[0]![0];
        expect(request.toolName).toBe('Bash');
        if (sidechain) {
          expect(request.requestId).not.toBe('toolu-current');
          expect(request.toolCallId).not.toBe('toolu-current');
        } else {
          expect(request).toMatchObject({ requestId: 'toolu-current', toolCallId: 'toolu-current' });
        }
      } finally { abort.abort(); await hook; }
    } finally { await envelope.operations.resetOrDisposeRuntime(); }
  });

  it('releases the native hook and publishes one exact tool occurrence through the existing dialog owner', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const requestDecision = vi.fn<SessionPermissionsService['requestDecision']>((_request, options) => new Promise(resolve => {
      options?.signal?.addEventListener('abort', () => resolve({ decision: 'abort' }), { once: true });
    }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: { requestDecision, getMode: () => 'default' },
      toolExecution: { before: async (call: { input: Record<string, unknown> }) => ({ status: 'continue', input: call.input }) },
    });
    const port = createFakeControlPort({ captures: [SCREEN] });
    vi.mocked(terminalHost.service.controlPort).mockResolvedValue(port);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx, directory: '/tmp/claude-project', happierSessionId: 'native-hook-session', hostPreference: 'zellij',
      launchEnv: {}, permissionMode: 'default',
    }));
    try {
      await envelope.operations.startProviderSession();
      const hooks = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]![0];
      const hookResult = hooks.onPermissionHook!({ hook_event_name: 'PreToolUse', session_id: 'native-session',
        tool_use_id: 'native-question-1', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] },
      });
      // The external hook may settle without a host answer; Claude owns the visible native form.
      let result: unknown;
      void Promise.resolve(hookResult).then(value => { result = value; });
      await vi.waitFor(() => expect(result).toBeDefined());
      expect(result).toEqual({ continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: 'PreToolUse' } });
      await vi.waitFor(() => expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'native-question-1', toolCallId: 'native-question-1', toolName: 'AskUserQuestion',
        input: expect.objectContaining({ questions: [expect.objectContaining({ question: 'Which probe color?' })] }),
      }), expect.anything()));
      expect(requestDecision).toHaveBeenCalledTimes(1);
      expect(port.sentKeys).toEqual([]);
    } finally {
      await envelope.operations.resetOrDisposeRuntime();
    }
  });
});
