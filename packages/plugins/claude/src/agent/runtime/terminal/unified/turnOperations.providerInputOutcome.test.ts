import { describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.testkit.js';

describe('Claude Unified provider input outcomes', () => {
  it.each(['after injection', 'during injection'] as const)('does not credit a delayed JSONL echo to a newer identical input: %s', async (echoTiming) => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    // The OS file-follow boundary delivers native rows; all projection/lifecycle/arbiter logic is real.
    vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mockResolvedValue({
      id: 'acceptance-evidence-follow',
      drainNow: async () => undefined,
      close: async () => undefined,
    });
    const runtime = createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-acceptance-evidence',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      nativeOperationsOnly: true,
    });
    const accepted: string[] = [];
    runtime.setOnPromptAcceptedByProvider((input) => { accepted.push(...(input.localIds ?? [])); });
    try {
      await runtime.startProviderSession();
      const hooks = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hooks?.onSessionHook) throw new Error('Hook server was not started');
      await hooks.onSessionHook('claude-evidence', {
        hook_event_name: 'SessionStart', session_id: 'claude-evidence',
        transcript_path: '/tmp/claude-evidence.jsonl', source: 'startup',
      });
      await runtime.sendTurnPrompt('same prompt', { localId: 'first', localIds: ['first'], userMessageSeq: 1 });
      await hooks.onSessionHook('claude-evidence', {
        hook_event_name: 'UserPromptSubmit', session_id: 'claude-evidence',
        prompt: 'same prompt', prompt_id: 'native-prompt-first', turnId: 'shared-turn',
      });
      expect(accepted).toEqual(['first']);
      const follow = vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mock.calls[0]?.[0];
      if (!follow) throw new Error('Transcript follow was not bound');
      const emitDelayedEcho = () => runtime.observeSourceTranscript({
        providerSessionId: 'claude-evidence', sourceId: 'source:first-echo',
        row: { type: 'user', uuid: 'different-jsonl-uuid', promptId: 'native-prompt-first',
          sessionId: 'claude-evidence', isSidechain: false, message: { role: 'user', content: 'same prompt' } },
      });
      runtime.beginTurnLifecycle();
      if (echoTiming === 'during injection') {
        terminalHost.service.injectUserPrompt.mockImplementationOnce(async (_handle, input) => {
          await emitDelayedEcho();
          return {
            status: 'injected', injectedAt: 1_100, bytesWritten: input.text.length,
            hostKind: terminalHost.handle.kind, hostSessionName: terminalHost.handle.sessionName,
          };
        });
      }
      await runtime.sendTurnPrompt('same prompt', { localId: 'second', localIds: ['second'], userMessageSeq: 2 });
      if (echoTiming === 'after injection') await emitDelayedEcho();
      expect(accepted).toEqual(['first']);
      await hooks.onSessionHook('claude-evidence', {
        hook_event_name: 'UserPromptSubmit', session_id: 'claude-evidence',
        prompt: 'same prompt', prompt_id: 'native-prompt-second', turnId: 'shared-turn',
      });
      await runtime.observeSourceTranscript({
        providerSessionId: 'claude-evidence', sourceId: 'source:second-echo',
        row: { type: 'user', uuid: 'second-jsonl-uuid', promptId: 'native-prompt-second', promptSource: 'queued',
          sessionId: 'claude-evidence', isSidechain: false, message: { role: 'user', content: 'same prompt' } },
      });
      expect(accepted).toEqual(['first', 'second']);
    } finally {
      await runtime.resetOrDisposeRuntime();
    }
  });

  it('reports pre-Enter terminal ambiguity immediately so the host can durably block the Pending row', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-pre-enter-ambiguous',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      send(
        input: Readonly<{ v: 1; text: string }>,
        options: Readonly<{ localInputId: string; userMessageSeq: number }>,
      ): Promise<unknown>;
      setOnPromptDeliveryOutcome(
        handler: (outcome: Readonly<{
          type: 'custody_observed' | 'provider_accepted' | 'rejected_before_write' | 'possible_write';
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          reason?: string;
        }>) => void,
      ): void;
    }>;
    const outcomes: unknown[] = [];
    nativeRuntime.setOnPromptDeliveryOutcome((outcome) => outcomes.push({ ...outcome }));
    terminalHost.service.injectUserPrompt.mockResolvedValueOnce({
      status: 'failed',
      reason: 'timeout',
      phase: 'after_write_before_enter',
      recoverable: true,
      duplicateRisk: 'possible',
      observedAt: 1_100,
      hostKind: terminalHost.handle.kind,
      hostSessionName: terminalHost.handle.sessionName,
      ...(terminalHost.handle.paneId ? { paneId: terminalHost.handle.paneId } : {}),
    });

    try {
      await nativeRuntime.send(
        { v: 1, text: 'prompt staged in the terminal but not submitted' },
        { localInputId: 'local-pre-enter-ambiguous', userMessageSeq: 46 },
      );

      expect(outcomes).toEqual([{
        type: 'possible_write',
        localIds: ['local-pre-enter-ambiguous'],
        userMessageSeq: 46,
        userMessageSeqs: [46],
        reason: 'ambiguous_terminal_delivery',
      }]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports terminalized post-Enter ambiguity through the public runtime outcome without claiming pre-effect rejection', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-post-enter-ambiguous',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      send(
        input: Readonly<{ v: 1; text: string }>,
        options: Readonly<{ localInputId: string; userMessageSeq: number }>,
      ): Promise<unknown>;
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      setOnPromptDeliveryOutcome(
        handler: (outcome: Readonly<{
          type: 'custody_observed' | 'provider_accepted' | 'rejected_before_write' | 'possible_write';
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          reason?: string;
        }>) => void,
      ): void;
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
        }>) => void,
      ): void;
    }>;
    const outcomes: unknown[] = [];
    const rejected: unknown[] = [];
    nativeRuntime.setOnPromptDeliveryOutcome((outcome) => outcomes.push({ ...outcome }));
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
    terminalHost.service.injectUserPrompt.mockResolvedValueOnce({
      status: 'failed',
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      recoverable: true,
      duplicateRisk: 'possible',
      observedAt: 1_100,
      hostKind: terminalHost.handle.kind,
      hostSessionName: terminalHost.handle.sessionName,
      ...(terminalHost.handle.paneId ? { paneId: terminalHost.handle.paneId } : {}),
    });

    try {
      await nativeRuntime.send(
        { v: 1, text: 'prompt whose Enter result later becomes unknowable' },
        { localInputId: 'local-post-enter-ambiguous', userMessageSeq: 47 },
      );
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'terminal_observation_lost',
        detail: 'Claude terminal outcome could not be observed after Enter',
        source: 'terminal',
      });

      expect(outcomes).toEqual([{
        type: 'possible_write',
        localIds: ['local-post-enter-ambiguous'],
        userMessageSeq: 47,
        userMessageSeqs: [47],
        reason: 'ambiguous_terminal_delivery',
      }]);
      expect(rejected).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
