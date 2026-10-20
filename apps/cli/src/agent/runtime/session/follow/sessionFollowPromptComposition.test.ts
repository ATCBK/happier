import { describe, expect, it, vi } from 'vitest';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding } from '@/agent/runtime/session/input/providerInputOutcome';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';

describe('Session Follow prompt composition through the canonical owner', () => {
  it.each(['goal_changed', 'message'] as const)('composes an admitted %s original and ACKs only its exact accepted input', async kind => {
    const delivered = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { ...delivered, transcriptSeq: 1 };
    const localInputId = 'admitted-original';
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: kind === 'goal_changed' ? 'wake' : 'next_turn',
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'source-original', seq: 1 } }, event: { kind } });
    const acknowledgeSessionFollow = vi.fn(async (_request: unknown) => ({
      ok: true as const, v: 1 as const, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: observed,
    }));
    // Socket observation/ACK and source HTTP are boundaries; hydration,
    // selection, composition and acceptance custody execute their real owners.
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async () => ({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7', currentSourceSessionIds: ['source'],
        observations: [{ kind: 'admitted_input', localInputId, sourceSessionId: 'source', destinationSessionId: 'destination',
          delivered, observed, delivery }],
      }),
      acknowledgeSessionFollow,
      reconcileSessionInputForProviderDispatch: async () => 'admitted',
    } });
    const material = createSessionFollowSourceMaterialResolver();
    try {
      const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
        sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async () =>
          SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1,
            source: { id: 'source', encryptionMode: 'plain', metadata: '{}', archivedAt: null,
              createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: null,
              latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null,
              meaningfulActivityAt: null, agentStateVersion: 0 },
            messages: [{ seq: 1, createdAt: 1, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
              content: kind === 'goal_changed' ? { type: 'event', data: { type: 'goal-changed' } }
                : { type: 'codex', data: { type: 'message', message: 'Please review' } } } } }], hasMore: false,
          }),
        } });
      const reconciler = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 });
      const prepared = await reconciler({ signal: new AbortController().signal,
        followDeliveries: [{ delivery, localInputId, userMessageSeq: 2 }] });
      expect(prepared?.representedFollowLocalInputIds).toEqual([localInputId]);
      expect(prepared?.wakeEventLocalId).toBeUndefined();
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      const prompt = renderSessionInputContextPromptV1({ sessionFollowUpdates: prepared!.updates,
        transformedUserText: 'ACTUAL_INPUT' });
      expect(prompt).toContain('<session_follow>');
      expect(prompt).toContain(kind === 'goal_changed' ? 'goal changed' : 'Please review');
      expect(prompt.endsWith('ACTUAL_INPUT')).toBe(true);
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'another-input', userMessageSeq: 2 });
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      if (kind === 'message') {
        session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode,
          { batcher: combinePermissionModeQueuedPrompts });
        queue.push({ text: 'ACTUAL_INPUT', localId: 'natural-input', userMessageSeq: 3,
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
          followDeliveries: [{ delivery, localInputId, userMessageSeq: 2 }] }, { permissionMode: 'default' });
        let emitNative: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        const sent: Array<{ text: string; inputIds: readonly string[] }> = [];
        // Only the external Agent and Session persistence/HTTP are boundaries.
        // Native correlation, prompt preparation, Follow selection and acceptance are real.
        const native: AgentSessionRuntime = {
          send: async request => {
            sent.push({ text: request.input.text, inputIds: request.inputIds });
            if (request.delivery.kind !== 'newTurn') throw new Error('Expected natural newTurn');
            const turnId = request.delivery.turnId;
            emitNative?.({ kind: 'input-accepted', sessionId: 'destination', inputIds: request.inputIds,
              delivery: request.delivery, sequence: ++sequence, emittedAtMs: 1 });
            emitNative?.({ kind: 'turn-start', sessionId: 'destination', turnId, startedBy: 'host', sequence: ++sequence, emittedAtMs: 1 });
            queueMicrotask(() => emitNative?.({ kind: 'turn-complete', sessionId: 'destination', turnId,
              sequence: ++sequence, emittedAtMs: 2 }));
            return { status: 'admitted' };
          },
          watch: handler => { emitNative = handler; return { dispose: () => { emitNative = undefined; } }; },
          dispose: async () => undefined,
        };
        const signal = new AbortController().signal;
        const runtime = createNativeAgentSessionOperations(native, 'destination', undefined, undefined, undefined,
          undefined, undefined, {
            // The selected newTurn-only external fixture consumes only cancellation.
            context: { signal } as AgentSessionRuntimeContext, cwd: '/tmp', connectedAccounts: [],
            capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
          });
        const settled: string[] = [];
        const binding = createSessionProviderInputOutcomeBinding({
          getTarget: () => ({ sessionId: 'destination', hasPendingProviderInput: id => id === localInputId || id === 'natural-input',
            observeProviderInputSettlement: async outcome => { if (outcome.kind === 'accepted') settled.push(outcome.localId); } }),
        });
        const unbind = bindSessionProviderInputOutcome({ runtime, observe: binding.observeProviderInputOutcome, wakePendingMaterialization() {} });
        const permission = createProviderEnforcedPermissionHandler({ session, logPrefix: '[quiet Follow composition]' });
        const failures: unknown[] = [];
        let done = false;
        try {
          await runPermissionModePromptLoop({ providerName: 'External Agent', agentMessageType: 'qwen',
            explicitPermissionMode: undefined, session, messageQueue: queue, permissionHandler: permission, runtime,
            createOverrideSynchronizer: isStarted => createRuntimeOverrideSynchronizers({
              agentTargetKey: 'agent:happier.agent.codex/codex', session, isStarted,
              runtime: {
                setSessionMode: modeId => runtime.updateSessionRuntimeConfig({ modeId }),
                setSessionConfigOption: (id, value) => runtime.updateSessionRuntimeConfig({ configOption: { id, value } }),
                setSessionModelSelection: async selection => { await runtime.updateSessionRuntimeConfig({ modelId: selection.modelId }); },
              },
            }),
            messageBuffer: new MessageBuffer(), shouldExit: () => done, getAbortSignal: () => signal,
            keepAlive() {}, setThinking() {}, sendReady() { done = true; }, currentPermissionModeUpdatedAt: 0,
            setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {}, formatPromptErrorMessage: String,
            onPromptFailure: async error => {
              failures.push(error);
              done = true;
              // Release the fixture's real pending-turn wait after a pre-send
              // correlation refusal; do not mistake a cleanup timeout for RED.
              await runtime.resetOrDisposeRuntime();
            },
            prepareHostContext: input => reconciler(input),
            registerProviderAcceptedEffect: binding.registerProviderAcceptedEffect,
          });
          expect(failures).toEqual([]);
          expect(sent).toHaveLength(1);
          expect(sent[0]?.inputIds).toEqual(['natural-input']);
          expect(sent[0]?.text).toContain('Please review');
          expect(sent[0]?.text.endsWith('ACTUAL_INPUT')).toBe(true);
          await vi.waitFor(() => expect(settled).toEqual([localInputId, 'natural-input']));
        } finally {
          unbind();
          binding.clearAcceptedEffects();
          await runtime.resetOrDisposeRuntime();
          await permission.reset();
        }
      } else prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId, userMessageSeq: 2 });
      await vi.waitFor(() => expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
        localInputId, sourceSessionId: 'source', expected: delivered, consumed: observed,
        acceptance: { kind: 'admitted_input', localInputId, userMessageSeq: 2 },
      })));
    } finally { material.dispose(); }
  });
});
