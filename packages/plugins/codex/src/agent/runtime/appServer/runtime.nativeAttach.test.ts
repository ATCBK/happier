import { describe, expect, it } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createCodexNativeAppServerSessionRuntime } from './native.js';
import { startCodexAppServerRuntime } from './runtime.js';
import { withCodexNativeAttachFixture as withFixture } from './runtime.nativeAttach.test-support.js';

describe('native Codex attachment preparation', () => {
  it.each(['assistant', 'reasoning'] as const)('clears an existing %s draft with an empty normalized final without manufacturing empty output', async (channel) => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-empty-final');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      for (let turn = 1; turn <= 2; turn += 1) {
        const turnId = `empty-final-turn-${turn}`;
        const hasDraft = turn === 1;
        await session.send({
          inputIds: [`empty-input-${turn}`], input: { text: 'Use the final output' },
          delivery: { kind: 'newTurn', turnId },
        });
        if (hasDraft) emitNotification(channel === 'assistant' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'removed', delta: 'Removed draft',
        });
        emitNotification('item/completed', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: { id: 'removed', type: channel === 'assistant' ? 'agentMessage' : 'reasoning', text: '' },
        });
        emitNotification('item/agentMessage/delta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'retained', delta: 'Retained answer',
        });
        emitNotification('item/completed', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: { id: 'retained', type: 'agentMessage', text: 'Retained answer' },
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread', turn: { id: `provider-turn-${turn}`, status: 'completed' },
        });
        await expect.poll(() => events.some((event) => event.kind === 'turn-complete' && event.turnId === turnId)).toBe(true);
        const output = events.filter((event) => event.turnId === turnId);
        const snapshots = output.filter((event) => event.kind === 'transcript-message-committed');
        if (hasDraft) {
          const draft = output.find((event) => event.kind === 'message-delta' && event.text === 'Removed draft');
          expect(draft).toMatchObject({ kind: 'message-delta', channel, messageId: expect.any(String) });
          if (draft?.kind !== 'message-delta' || !draft.messageId) throw new Error('Missing draft identity');
          expect(snapshots).toMatchObject([{ role: channel, text: '', messageId: draft.messageId }]);
          if (channel === 'assistant') expect(output.filter((event) => event.kind === 'message-delta' || event.kind === 'transcript-message-committed')).toMatchObject([
            { kind: 'message-delta', text: 'Removed draft' },
            { kind: 'transcript-message-committed', text: '' },
            { kind: 'message-delta', text: 'Retained answer' },
          ]);
        } else {
          expect(snapshots).toEqual([]);
          expect(output.filter((event) => event.kind === 'message-delta').map((event) => event.text)).toEqual(['Retained answer']);
        }
        expect(output).toContainEqual(expect.objectContaining({ kind: 'message-delta', channel: 'assistant', text: 'Retained answer' }));
      }
    });
  });

  it('correlates a corrected reasoning snapshot with its streamed segment', async () => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-reasoning-replacement');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      await session.send({
        inputIds: ['reasoning-input'], input: { text: 'Think through the report' },
        delivery: { kind: 'newTurn', turnId: 'reasoning-turn' },
      });
      emitNotification('item/reasoning/textDelta', {
        threadId: 'fresh-thread', turnId: 'provider-turn-1', itemId: 'analysis', delta: 'Draft analysis',
      });
      emitNotification('item/completed', {
        threadId: 'fresh-thread', turnId: 'provider-turn-1',
        item: { id: 'analysis', type: 'reasoning', text: 'Corrected analysis' },
      });
      emitNotification('turn/completed', {
        threadId: 'fresh-thread', turn: { id: 'provider-turn-1', status: 'completed' },
      });
      await expect.poll(() => events.some((event) => event.kind === 'turn-complete')).toBe(true);
      const delta = events.find((event) => event.kind === 'message-delta');
      expect(delta).toMatchObject({ kind: 'message-delta', channel: 'reasoning', text: 'Draft analysis', messageId: expect.any(String) });
      if (delta?.kind !== 'message-delta' || !delta.messageId) throw new Error('Missing reasoning message identity');
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'transcript-message-committed', role: 'reasoning', text: 'Corrected analysis',
        messageId: delta.messageId, turnId: 'reasoning-turn',
      }));
    });
  });

  it.each(['item/completed', 'rawResponseItem/completed'] as const)('correlates corrected assistant snapshots with their streamed message and exact host turn (%s)', async (finalMethod) => {
    await withFixture(async ({ runtime, emitNotification }) => {
      await startCodexAppServerRuntime(runtime);
      const session = createCodexNativeAppServerSessionRuntime(runtime, 'session-replacement');
      const events: AgentSessionRuntimeEvent[] = [];
      session.watch((event) => events.push(event));
      const messageIds: string[] = [];
      for (let turn = 1; turn <= 2; turn += 1) {
        const turnId = `host-turn-${turn}`;
        await session.send({
          inputIds: [`input-${turn}`], input: { text: 'Produce the final report' },
          delivery: { kind: 'newTurn', turnId },
        });
        emitNotification('item/agentMessage/delta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'report', delta: 'Draft report',
        });
        emitNotification(finalMethod, {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: finalMethod === 'item/completed'
            ? { id: 'report', type: 'agentMessage', text: 'Corrected report' }
            : { id: 'report', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Corrected report' }] },
        });
        emitNotification('item/agentMessage/delta', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`, itemId: 'acknowledgment', delta: 'Artifact delivered.',
        });
        emitNotification('item/completed', {
          threadId: 'fresh-thread', turnId: `provider-turn-${turn}`,
          item: { id: 'acknowledgment', type: 'agentMessage', text: 'Artifact delivered.' },
        });
        emitNotification('turn/completed', {
          threadId: 'fresh-thread', turn: { id: `provider-turn-${turn}`, status: 'completed' },
        });
        await expect.poll(() => events.some((event) => event.kind === 'turn-complete' && event.turnId === turnId)).toBe(true);
        const delta = events.find((event) => event.kind === 'message-delta' && event.turnId === turnId);
        expect(delta).toMatchObject({ kind: 'message-delta', channel: 'assistant', text: 'Draft report', messageId: expect.any(String) });
        if (delta?.kind !== 'message-delta' || !delta.messageId) throw new Error('Missing assistant message identity');
        messageIds.push(delta.messageId);
        expect(events).toContainEqual(expect.objectContaining({
          kind: 'transcript-message-committed', role: 'assistant', text: 'Corrected report',
          messageId: delta.messageId, turnId,
        }));
        expect(events.filter((event) => event.turnId === turnId
          && (event.kind === 'message-delta' || event.kind === 'transcript-message-committed'))).toMatchObject([
          { kind: 'message-delta', text: 'Draft report' },
          { kind: 'transcript-message-committed', text: 'Corrected report' },
          { kind: 'message-delta', text: 'Artifact delivered.' },
        ]);
      }
      expect(messageIds[0]).not.toBe(messageIds[1]);
    });
  });

  it.each([
    ['no rollout found for thread id missing-thread', 'AGENT_RESUME_PROVIDER_STATE_MISSING'],
    ['provider temporarily unavailable', undefined],
  ])('classifies resume rejection %s without starting a replacement thread', async (message, code) => {
    await withFixture(async ({ runtime, requests, failResume }) => {
      failResume(message);
      const error = await startCodexAppServerRuntime(runtime, {
        resumeId: 'missing-thread', preserveRequestedThreadId: true,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error & { code?: unknown }).code).toBe(code ?? -32000);
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('preserves the typed missing-state reason through native session startup sanitization', async () => {
    await withFixture(async ({ openConfiguredSession, requests, failResume }) => {
      failResume('no rollout found for thread id missing-thread');
      const error = await openConfiguredSession('missing-thread').catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 'AGENT_RESUME_PROVIDER_STATE_MISSING' });
      expect(requests.filter((request) => request.method === 'thread/resume').map((request) => request.params.threadId))
        .toEqual(['missing-thread']);
      expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    });
  });
  it.skipIf(process.platform === 'win32')('applies initial canonical effort before startup instructions initialize the native attachment thread', async () => {
    await withFixture(async ({ openConfiguredSession, requests }) => {
      const session = await openConfiguredSession();
      await session.prepareTerminalPresentation?.();
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({
        model: 'fixture-model', permissions: ':read-only',
        config: { model_reasoning_effort: 'low' },
        developerInstructions: 'Actual startup instructions.',
      });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    });
  });
  it('materializes zero-turn fresh threads once and preserves identity and policy on repeat attach', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' });
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toEqual([{ method: 'thread/name/set', params: { threadId: 'fresh-thread', name: 'Happier session actual-happier-session' } }]);
      expect(requests.filter((r) => r.method === 'thread/read')).toEqual([{ method: 'thread/read', params: { threadId: 'fresh-thread', includeTurns: true } }]);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({ permissions: ':read-only', config: { model_reasoning_effort: 'low' } });
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      await runtime.updateConfig?.({ permissionMode: 'acceptEdits' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    });
  });

  it('keeps an existing resumed thread name and does not initialize a new thread', async () => {
    await withFixture(async ({ runtime, requests }) => {
      await startCodexAppServerRuntime(runtime, { resumeId: 'existing-thread', importHistory: false });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('existing-thread');
      expect(requests.filter((r) => ['thread/start', 'thread/name/set', 'thread/read', 'turn/start'].includes(r.method))).toEqual([]);
    });
  });

  it('materializes a realtime-published zero-turn thread before native resume without replacing its identity', async () => {
    await withFixture(async ({ runtime, requests, resume }) => {
      await startCodexAppServerRuntime(runtime);
      const started = await runtime.realtimeConversation.start({ transport: { kind: 'webrtc', offerSdp: 'offer' } });
      expect(started.status).toBe('started');
      if (started.status !== 'started') throw new Error('Realtime fixture failed to start');
      expect(runtime.identity.read()).toEqual({ providerSessionId: 'fresh-thread' });
      await expect(resume()).rejects.toThrow('no rollout found');

      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      await expect(resume()).resolves.toMatchObject({ thread: { id: 'fresh-thread', turns: [] } });
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/name/set')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
      expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
      await started.handle.stop();
      await runtime.updateConfig?.({ modelId: 'later-model' });
      await expect(runtime.prepareProviderCliAttach()).resolves.toBe('fresh-thread');
      expect(requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'thread/read')).toHaveLength(1);
    });
  });

  it('withholds attachment identity if the fresh rollout cannot be materialized', async () => {
    await withFixture(async ({ runtime, failRead }) => {
      failRead();
      await expect(runtime.prepareProviderCliAttach()).rejects.toThrow('rollout persistence failed');
      expect(runtime.identity.read()).toEqual({ providerSessionId: null });
    });
  });
});
