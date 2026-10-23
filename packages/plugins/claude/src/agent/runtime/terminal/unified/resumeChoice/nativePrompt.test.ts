import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SessionPermissionDecisionRequest, SessionPermissionDecisionResult, SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { createEventsFixture, createPluginContextFixture, createTerminalHostFixture } from '../../../engine.testkit.js';
import { createFakeControlPort } from '../tuiControls/fakeControlPort.js';
import { parseClaudeScreenState } from '../screenState.js';
import { createClaudePermissionHookHandler } from '../../../shared/permissionHookHandler.js';
import { createClaudeUnifiedResumeChoiceStartupHandler } from './startup.js';

const QUESTIONS = [{ question: 'Which probe color?', header: 'Header Color', multiSelect: false,
  options: [{ label: 'Amber', description: 'Warm amber probe color.' }, { label: 'Blue', description: 'Cool blue probe color.' }] }];
const SCREEN = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.304-question-single.txt', import.meta.url), 'utf8');
const BLUE = SCREEN.replace('❯ 1. Amber', '  1. Amber').replace('  2. Blue', '❯ 2. Blue');
const IDLE = '──────────────────\n❯ \n──────────────────';
type DecisionOptions = Parameters<SessionPermissionsService['requestDecision']>[1];

function createHarness(captures: readonly string[], onEnter?: () => Promise<void> | void) {
  const pending: { request: SessionPermissionDecisionRequest; options: DecisionOptions; resolve: (value: SessionPermissionDecisionResult) => void }[] = [];
  const requestDecision = vi.fn<SessionPermissionsService['requestDecision']>((request, options) => new Promise(resolve => {
    pending.push({ request, options, resolve });
    options?.signal?.addEventListener('abort', () => resolve({ decision: 'abort' }), { once: true });
  }));
  const settleObservedDecision = vi.fn<NonNullable<SessionPermissionsService['settleObservedDecision']>>(async (observed) => {
    pending.find(entry => entry.request.requestId === observed.requestId)?.resolve({ decision: observed.decision, answers: observed.answers });
    return true;
  });
  const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
    sessionPermissions: { requestDecision, settleObservedDecision, getMode: () => 'default' },
    toolExecution: { before: async (call: { input: Record<string, unknown> }) => ({ status: 'continue', input: call.input }) },
  });
  const port = createFakeControlPort({ captures, onSendSpecialKey: async (key) => { if (key === 'Enter') await onEnter?.(); } });
  const handler = createClaudeUnifiedResumeChoiceStartupHandler({ ctx, sessionId: 'session-native', port,
    wait: async () => {}, settleMs: 0, verifyPollIntervalMs: 1, verifyPollTimeoutMs: 8,
  });
  const hook = (id: string, location = 'app_and_terminal') => handler.observeSessionHook({
    hook_event_name: 'ClaudeNativePrompt', session_id: 'native', tool_use_id: id,
    tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS }, happierResponseLocation: location,
  });
  return { ctx, handler, hook, pending, requestDecision, settleObservedDecision, port };
}

describe('native occurrences through the generalized Claude dialog owner', () => {
  it('waits for paint then publishes the original tool ID without writing terminal bytes', async () => {
    const h = createHarness(['', SCREEN]);
    try {
      await h.hook('question-1');
      expect(await h.handler.handle(parseClaudeScreenState('✻ Thinking…'))).toBe('waiting_for_user');
      expect(h.pending.map(entry => entry.request.requestId)).toEqual(['question-1']);
      expect(h.pending[0]!.request.input).toMatchObject({ questions: [expect.objectContaining({ question: 'Which probe color?' })] });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('publishes the existing terminal notice for a native form that does not match its tool question', async () => {
    const mismatched = SCREEN.replaceAll('Which probe color?', 'A different native question?').replaceAll('Header Color', 'Unrelated Header');
    const h = createHarness([mismatched]);
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(mismatched));
      expect(h.pending[0]?.request.input).toMatchObject({ happierDialog: { kind: 'unrecognized', mode: 'notice' } });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('keeps terminal-only native questions outside the app request owner', async () => {
    const h = createHarness([SCREEN]);
    try {
      await h.hook('question-1', 'terminal_only');
      expect(await h.handler.handle(parseClaudeScreenState(SCREEN))).toBe('unhandled');
      expect(h.requestDecision).not.toHaveBeenCalled();
    } finally { await h.handler.dispose(); }
  });

  it.each([true, false])('settles the actual terminal question outcome (approved: %s)', async (approved) => {
    const h = createHarness([SCREEN]);
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      await h.handler.observeTranscript({ sessionId: 'native', type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'question-1', is_error: !approved }] },
        toolUseResult: approved ? { answers: { 'Which probe color?': 'Blue' } } : {},
      });
      expect(h.settleObservedDecision).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'question-1',
        decision: approved ? 'approved' : 'abort',
        ...(approved ? { answers: { 'Which probe color?': ['Blue'] } } : {}),
      }));
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('settles the original published native question after the same exact hook is delivered twice', async () => {
    const h = createHarness([SCREEN]);
    const permissionHook = createClaudePermissionHookHandler(h.ctx, {
      unifiedTerminalActive: true,
      responseLocations: { question: 'app_and_terminal', permission: 'app_and_terminal' },
      resolveToolUseId: h.handler.resolveToolUseId,
      onNativePrompt: h.handler.observeSessionHook,
      onPermissionLifecycle: h.handler.observeSessionHook,
    });
    const data = { hook_event_name: 'PreToolUse', session_id: 'native', tool_use_id: 'question-repeat',
      tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } };
    try {
      await permissionHook(data);
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      expect(h.pending.map(entry => entry.request.requestId)).toEqual(['question-repeat']);
      await permissionHook(data);
      expect(h.requestDecision).toHaveBeenCalledTimes(1);
      expect(h.pending[0]!.options!.signal!.aborted).toBe(false);
      await h.handler.observeTranscript({ sessionId: 'native', type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'question-repeat', is_error: false }] },
        toolUseResult: { answers: { 'Which probe color?': 'Blue' } },
      });
      expect(h.settleObservedDecision).toHaveBeenCalledWith({ requestId: 'question-repeat',
        source: 'claude_unified_terminal_dialog_choice', decision: 'approved',
        answers: { 'Which probe color?': ['Blue'] },
      });
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.handler.hasNativePrompt()).toBe(false);
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('keeps a new native occurrence when the previous app answer finishes', async () => {
    let h!: ReturnType<typeof createHarness>;
    h = createHarness([SCREEN, BLUE, SCREEN], async () => {
      await h.hook('question-2');
      await h.handler.observeSessionHook({ hook_event_name: 'PostToolUse', session_id: 'native', tool_use_id: 'question-1',
        tool_response: { answers: { 'Which probe color?': 'Blue' } },
      });
    });
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      const result = { decision: 'approved' as const, answers: { 'Which probe color?': ['Blue'] } };
      await h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      h.pending[0]!.resolve(result);
      await vi.waitFor(() => expect(h.pending.map(entry => entry.request.requestId)).toEqual(['question-1', 'question-2']));
      expect(h.handler.hasNativePrompt()).toBe(true);
      expect(h.pending[1]!.options!.signal!.aborted).toBe(false);
    } finally { await h.handler.dispose(); }
  });

  it('retires an app-applied native permission context while its accepted command is still running', async () => {
    const permission = readFileSync(new URL('../tuiControls/__fixtures__/claude-2.1.309-permission-no-focused.txt', import.meta.url), 'utf8')
      .replace('   1. Yes', ' ❯ 1. Yes').replace(' ❯ 4. No', '   4. No');
    const h = createHarness([permission, IDLE]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'ClaudeNativePrompt', session_id: 'native',
        tool_use_id: 'permission-1', tool_name: 'Bash', tool_input: { command: 'sleep 600' },
      });
      await h.handler.handle(parseClaudeScreenState(permission));
      const result = { decision: 'approved' as const, answers: { claudeNativePermission: ['option_1'] } };
      await h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      h.pending[0]!.resolve(result);
      await vi.waitFor(() => expect(h.handler.hasPendingUserAction()).toBe(false));
      expect(h.handler.hasNativePrompt()).toBe(false);
      expect(h.port.sentKeys).toEqual(['Enter']);
    } finally { await h.handler.dispose(); }
  });

  it.each([['accept', false], ['reject', false], ['accept', true]] as const)('settles an app-prompt native permission from exact %s after Stop=%s', async (decision, stop) => {
    const h = createHarness([IDLE]);
    try {
      await h.handler.observeSessionHook({ hook_event_name: 'PreToolUse', session_id: 'native', tool_use_id: 'app-permission-1',
        tool_name: 'Bash', tool_input: { command: 'missing-command' },
      });
      await h.handler.observeSessionHook({ hook_event_name: 'PermissionRequest', session_id: 'native', tool_use_id: 'app-permission-1',
        tool_name: 'Bash', tool_input: { command: 'missing-command' },
      });
      if (stop) await h.handler.observeSessionHook({ hook_event_name: 'Stop', session_id: 'native' });
      const result = { sessionId: 'native', type: 'user', permissionDecision: { decision },
        message: { content: [{ type: 'tool_result', tool_use_id: 'app-permission-1', is_error: true }] },
      };
      await h.handler.observeTranscript({ ...result, sessionId: 'foreign' });
      await h.handler.observeTranscript({ ...result, isSidechain: true });
      await h.handler.observeTranscript({ ...result, parent_tool_use_id: 'child-tool' });
      await h.handler.observeTranscript({ ...result, parentToolUseId: 'child-tool' });
      await h.handler.observeTranscript({ ...result, permissionDecision: undefined });
      expect(h.settleObservedDecision).not.toHaveBeenCalled();
      await h.handler.observeTranscript(result);
      expect(h.settleObservedDecision).toHaveBeenCalledWith({ requestId: 'app-permission-1',
        source: 'native_tool_approval_once', decision: decision === 'accept' ? 'approved' : 'denied',
      });
      expect(h.port.sentKeys).toEqual([]);
    } finally { await h.handler.dispose(); }
  });

  it('settles the old app permission after Stop while inferring only the next live same-input tool', async () => {
    const h = createHarness([IDLE]);
    const first = new AbortController();
    const next = new AbortController();
    const permissionHook = createClaudePermissionHookHandler(h.ctx, { unifiedTerminalActive: true,
      responseLocations: { question: 'app_only', permission: 'app_only' },
      resolveToolUseId: h.handler.resolveToolUseId, onNativePrompt: h.handler.observeSessionHook,
      onPermissionLifecycle: h.handler.observeSessionHook,
    });
    const data = { session_id: 'native', tool_name: 'Bash', tool_input: { command: 'echo same' } };
    let firstHook: Promise<unknown> | undefined;
    let nextHook: Promise<unknown> | undefined;
    try {
      await h.handler.observeSessionHook({ ...data, hook_event_name: 'PreToolUse', tool_use_id: 'old-permission' });
      firstHook = permissionHook({ ...data, hook_event_name: 'PermissionRequest' }, { signal: first.signal });
      await vi.waitFor(() => expect(h.pending[0]?.request.requestId).toBe('old-permission'));
      await h.handler.observeSessionHook({ hook_event_name: 'Stop', session_id: 'native' });
      await h.handler.observeSessionHook({ ...data, hook_event_name: 'PreToolUse', tool_use_id: 'next-permission' });
      nextHook = permissionHook({ ...data, hook_event_name: 'PermissionRequest' }, { signal: next.signal });
      await vi.waitFor(() => expect(h.pending[1]?.request.requestId).toBe('next-permission'));
      await h.handler.observeTranscript({ sessionId: 'native', type: 'user', permissionDecision: { decision: 'accept' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'old-permission', is_error: true }] },
      });
      expect(h.settleObservedDecision).toHaveBeenCalledWith({ requestId: 'old-permission',
        source: 'native_tool_approval_once', decision: 'approved',
      });
      await expect(firstHook).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
      expect(h.pending[1]!.options!.signal!.aborted).toBe(false);
      expect(h.port.sentKeys).toEqual([]);
    } finally {
      first.abort(); next.abort();
      await Promise.all([firstHook, nextHook]);
      await h.handler.dispose();
    }
  });

  it.each([true, false])('checks actual provider answers before app acknowledgement (matching: %s)', async (matching) => {
    let h!: ReturnType<typeof createHarness>;
    h = createHarness([SCREEN, BLUE, IDLE], async () => {
      await h.handler.observeSessionHook({ hook_event_name: 'PostToolUse', session_id: 'native', tool_use_id: 'question-1',
        tool_response: { answers: { 'Which probe color?': matching ? 'Blue' : 'Amber' } },
      });
    });
    try {
      await h.hook('question-1');
      await h.handler.handle(parseClaudeScreenState(SCREEN));
      const result = { decision: 'approved' as const, answers: { 'Which probe color?': ['Blue'] } };
      const application = h.pending[0]!.options!.acknowledgeDecisionApplication!(result);
      if (matching) await expect(application).resolves.toBeUndefined();
      else await expect(application).rejects.toThrow('claude_unified_dialog_terminal_answer_failed');
      expect(h.port.sentKeys).toEqual(['ArrowDown', 'Enter']);
      expect(h.settleObservedDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved',
        answers: { 'Which probe color?': [matching ? 'Blue' : 'Amber'] },
      }));
    } finally { await h.handler.dispose(); }
  });
});
