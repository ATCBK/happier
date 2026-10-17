import { describe, expect, it } from 'vitest';

import { createFakeAcpRuntimeBackend } from '@/testkit/backends/acpRuntimeBackend';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createTestAcpRuntime as createAcpRuntime } from '@/testkit/backends/acpRuntime';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

/**
 * Provider-initiated turns (pi extensions such as AFT background bash inject real user
 * prompts into the provider session; the provider then starts a run without a Happier
 * prompt). These turns must open and close a task lifecycle turn so the session shows
 * as working in Happier clients, mirroring the claude session hook lifecycle.
 */
describe('createAcpRuntime (provider-initiated turns)', () => {
  function findTaskMarker(sent: any[], type: string): any | undefined {
    return sent.find((message) => message?.type === type);
  }

  it('opens a task turn when the provider reports running without a Happier turn in flight', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];
    const keepAliveCalls: Array<[boolean, string]> = [];
    const thinkingStates: boolean[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      keepAlive: (thinking, mode) => {
        keepAliveCalls.push([thinking, mode]);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: (thinking) => {
        thinkingStates.push(thinking);
      },
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });

    const taskStarted = findTaskMarker(sent, 'task_started');
    expect(taskStarted).toBeTruthy();
    expect(taskStarted.id).toEqual(expect.any(String));
    expect(keepAliveCalls).toContainEqual([true, 'remote']);
    expect(thinkingStates).toContain(true);
  });

  it('completes the provider-initiated task turn when the provider reports idle', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];
    const keepAliveCalls: Array<[boolean, string]> = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      keepAlive: (thinking, mode) => {
        keepAliveCalls.push([thinking, mode]);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'status', status: 'idle' });

    for (let attempt = 0; attempt < 50 && !findTaskMarker(sent, 'task_complete'); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const taskStarted = findTaskMarker(sent, 'task_started');
    const taskComplete = findTaskMarker(sent, 'task_complete');
    expect(taskStarted).toBeTruthy();
    expect(taskComplete).toBeTruthy();
    expect(taskComplete.id).toBe(taskStarted.id);
    expect(keepAliveCalls).toContainEqual([false, 'remote']);
  });

  it('does not open a provider-initiated turn while a Happier turn is in flight', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    runtime.beginTurn();
    backend.emit({ type: 'status', status: 'running' });
    await runtime.flushTurn();

    expect(sent.filter((message) => message?.type === 'task_started')).toHaveLength(1);
    expect(findTaskMarker(sent, 'task_complete')).toBeTruthy();
  });

  it('adopts the open provider-initiated turn when a Happier prompt turn begins', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    // Extension triggers a run while the session is idle...
    backend.emit({ type: 'status', status: 'running' });
    // ...and the user steers it with a Happier prompt before it finishes.
    runtime.beginTurn();
    await runtime.flushTurn();

    const providerTurnId = findTaskMarker(sent, 'task_started')?.id;
    expect(providerTurnId).toEqual(expect.any(String));
    expect(sent.filter((message) => message?.type === 'task_started')).toHaveLength(1);
    const taskComplete = findTaskMarker(sent, 'task_complete');
    expect(taskComplete).toBeTruthy();
    expect(taskComplete.id).toBe(providerTurnId);
  });

  it('cancels an open provider-initiated turn when the session runtime is cancelled', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    await runtime.cancel();

    const providerTurnId = findTaskMarker(sent, 'task_started')?.id;
    const turnCancelled = sent.find(
      (message) => message?.type === 'turn_cancelled' || message?.type === 'turn_aborted',
    );
    expect(turnCancelled).toBeTruthy();
    expect(turnCancelled.id).toBe(providerTurnId);
  });

  it('marks a provider-initiated turn cancelled, not completed, when idle races the cancel', async () => {
    // Pi's abort acknowledgement waits for provider idle, so the trailing agent_end can
    // arrive while cancel() is still awaiting the backend. The turn must end cancelled.
    const backend = createFakeAcpRuntimeBackend({
      cancel: async () => {
        backend.emit({ type: 'status', status: 'idle' });
      },
    });
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    await runtime.cancel();

    const providerTurnId = findTaskMarker(sent, 'task_started')?.id;
    expect(sent.some((message) => message?.type === 'task_complete')).toBe(false);
    const turnCancelled = sent.find((message) => message?.type === 'turn_cancelled');
    expect(turnCancelled).toBeTruthy();
    expect(turnCancelled.id).toBe(providerTurnId);
  });

  it('flushes the final assistant text before completing a provider-initiated turn', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const orderedRows: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        orderedRows.push(body);
      },
      sendAgentMessageCommitted: async (_provider, body) => {
        orderedRows.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'final answer', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });

    // The task_complete marker must land only after the flushed assistant row is durable.
    for (let attempt = 0; attempt < 50 && !orderedRows.some((message) => message?.type === 'task_complete'); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const taskCompleteIndex = orderedRows.findIndex((message) => message?.type === 'task_complete');
    const assistantRowIndex = orderedRows.findIndex(
      (message) => message?.type === 'message' && message?.message === 'final answer',
    );
    expect(assistantRowIndex).toBeGreaterThan(-1);
    expect(taskCompleteIndex).toBeGreaterThan(assistantRowIndex);
  });

  it('never lets the next provider turn open before the previous completion marker', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const sent: any[] = [];
    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'answer one', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });
    // The provider immediately starts its next run while the previous close is still
    // flushing; the new task_started must queue behind the pending task_complete.
    backend.emit({ type: 'status', status: 'running' });
    backend.emit({ type: 'model-output', fullText: 'answer two', fullTextScope: 'segment' });
    backend.emit({ type: 'status', status: 'idle' });

    for (let attempt = 0; attempt < 50 && sent.filter((message) => message?.type === 'task_complete').length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const firstTaskComplete = sent.findIndex((message) => message?.type === 'task_complete');
    const secondTaskStart = sent
      .map((message, index) => ({ message, index }))
      .filter((entry) => entry.message?.type === 'task_started')
      .at(1);
    expect(firstTaskComplete).toBeGreaterThan(-1);
    expect(secondTaskStart?.index).toBeGreaterThan(firstTaskComplete);
  });

  it('commits provider-observed user prompts to the transcript as user rows', async () => {
    const backend = createFakeAcpRuntimeBackend();
    const committedUserMessages: Array<{ text: string; opts: { localId: string; meta?: Record<string, unknown> } }> = [];
    const sent: any[] = [];

    const session = createBasicSessionClientWithOverrides({
      sendAgentMessage: (_provider, body) => {
        sent.push(body);
      },
      sendUserTextMessageCommitted: async (text, opts) => {
        committedUserMessages.push({ text, opts });
      },
    });

    const runtime = createAcpRuntime({
      provider: 'pi',
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend,
    });

    await runtime.startOrLoad({ resumeId: null });

    backend.emit({ type: 'user-message', text: '<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>' });

    expect(committedUserMessages).toHaveLength(1);
    expect(committedUserMessages[0]!.text).toBe('<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>');
    expect(committedUserMessages[0]!.opts.localId).toEqual(expect.stringMatching(/^provider-user-prompt:/));
    // Identical prompt text observed in two separate events commits two distinct rows:
    // the identity is per-occurrence, not text-derived, so legitimate repeats (e.g. two
    // "continue" injections) do not collapse into one transcript row.
    backend.emit({ type: 'user-message', text: '<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>' });
    expect(committedUserMessages).toHaveLength(2);
    expect(committedUserMessages[1]!.opts.localId).not.toBe(committedUserMessages[0]!.opts.localId);
    // Provider-observed user prompts are transcript rows, not ACP-forwarded agent messages.
    expect(sent.some((message) => typeof message?.message === 'string' && message.message.includes('BACKGROUND BASH'))).toBe(false);
  });
});
