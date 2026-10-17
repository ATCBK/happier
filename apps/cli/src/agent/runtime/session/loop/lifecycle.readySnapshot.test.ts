import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema } from '@happier-dev/protocol';

import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createUnsettledReplaySeedRetirement } from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import { extractAssistantTextSnapshotFromAcpMessage } from '@/api/session/turns/extractAssistantTextSnapshot';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';

describe('host ready after a provider successor starts', () => {
  it.each(['HOST_ANSWER', null])('preserves the completed host preview %s and successor activity', async hostAnswer => {
    const accountRequests: string[] = [];
    // Account HTTP is outside the host. The real project resolver receives a
    // current empty association census; unexpected network reads still fail.
    const accountGet = vi.spyOn(axios, 'get').mockImplementation(async url => {
      accountRequests.push(`GET ${String(url)}`);
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: {
        mode: 'plain', updatedAt: 1,
      } };
      throw new Error(`Unexpected account GET: ${String(url)}`);
    });
    const accountPost = vi.spyOn(axios, 'post').mockImplementation(async url => {
      accountRequests.push(`POST ${String(url)}`);
      if (String(url).endsWith('/v1/account/project-rows/list')) return { status: 200,
        data: { status: 'listed', rows: [], coverage: 'complete' } };
      throw new Error(`Unexpected account POST: ${String(url)}`);
    });
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(), pluginIds: [],
      }),
    });
    const sessionId = 'ready-handoff';
    let providerDispatchCount = 0;
    const secondHostAnswer = hostAnswer === null ? 'SECOND_HOST_ANSWER' : null;
    const committedMessages: unknown[] = [];
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const emit = (input: Readonly<Record<string, unknown>>) => {
      const event = AgentSessionRuntimeEventV1Schema.parse({ ...input, sessionId, sequence: ++sequence, emittedAtMs: sequence });
      for (const listener of listeners) listener(event);
    };
    // The vendor runtime is the external boundary. Native admission, transcript
    // projection, snapshot ownership, the prompt loop and ready dispatch are real.
    const provider: AgentSessionRuntime = {
      async send(request) {
        providerDispatchCount += 1;
        const answer = providerDispatchCount === 1 ? hostAnswer : secondHostAnswer;
        emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
        if (answer) emit({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: answer });
        emit({ kind: 'turn-complete', turnId: request.delivery.turnId });
        const successorTurnId = `provider-successor-${providerDispatchCount}`;
        emit({ kind: 'turn-start', turnId: successorTurnId, startedBy: 'provider' });
        emit({ kind: 'message-delta', turnId: successorTurnId, channel: 'assistant', text: 'SUCCESSOR_ANSWER' });
        return { status: 'admitted' };
      },
      watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined, {
      context: {} as AgentSessionRuntimeContext, cwd: '/tmp/ready-handoff', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
    });
    const metadata = createTestMetadata({ path: '/tmp/ready-handoff', permissionMode: 'default' });
    const snapshots = createTurnAssistantTextSnapshotStore();
    let observedSeq = 1;
    let secondHostSeq: number | null = null;
    const fixture = createMutableApiSessionClientFixture({ sessionId, metadata });
    const session = Object.assign(fixture, {
      turnAssistantTextSnapshotStore: snapshots,
      getTurnAssistantTextSnapshotStore: () => snapshots,
      getLastObservedMessageSeq: () => observedSeq,
      getCommittedUserMessageSeq: (localId: string) => localId === 'host-input' ? 1 : localId === 'host-input-2' ? secondHostSeq : null,
      enqueueSessionTurnMutation: async () => undefined,
      enqueueAgentMessageCommitted: async (
        providerId: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[0],
        body: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[1],
        options: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[2],
      ) => {
        committedMessages.push(body);
        const extracted = extractAssistantTextSnapshotFromAcpMessage(providerId, body);
        if (extracted) snapshots.observe({ ...extracted, localId: options.localId, seq: ++observedSeq, source: 'committed' });
        return { persisted: true as const, delivered: true as const };
      },
    });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
    queue.push({ text: 'host input', localId: 'host-input', userMessageSeq: 1 }, { permissionMode: 'default' });
    const runtimeState = { thinking: false };
    let ready = false;
    const controller = new AbortController();
    const readyPreviews: Array<string | null | undefined> = [];
    const thinkingAtReady: boolean[] = [];
    const params: SessionLoopLifecycleParams = {
      opts: { credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'ready-account' })).toString('base64url')}.signature`, encryption: null } },
      config: {
        flavor: 'default', policyAgentId: 'codex', backendDisplayName: 'Test Agent', uiLogPrefix: '[ReadyTest]',
        providerName: 'Test Agent', waitingForCommandLabel: 'Test Agent', agentMessageType: 'codex',
        runtimeActivityApplicability: 'not_applicable', machineMetadata: { host: 'test', platform: 'linux', happyCliVersion: '0.0.0-test', homeDir: '/tmp', happyHomeDir: '/tmp/happier', happyLibDir: '/tmp/happier/lib' },
        terminalDisplay: () => null, shouldRenderTerminalDisplay: () => false, formatPromptErrorMessage: String,
        lifecycleHooks: { createCheckpointLifecycle: () => ({}) },
      },
      api: { push: () => ({ sendToAllDevices() {}, async sendToAllDevicesAsync() { return true; } }) },
      // The canonical Session fixture substitutes the server/persistence boundary.
      session: session as unknown as SessionLoopLifecycleParams['session'],
      runtime, hookRuntime: runtime, registerProviderAcceptedEffect() {}, messageBuffer: new MessageBuffer(),
      permissionHandler: { reset() {}, setPermissionMode() {} },
      permissionModeState: {
        rebindSession() {}, releaseRejectedBeforeProviderPromptIdentity() {}, getCurrentPermissionMode: () => 'default',
        getCurrentPermissionModeUpdatedAt: () => 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
        messageQueue: queue, replaySeedRetirement: createUnsettledReplaySeedRetirement(),
      },
      sessionSwapStrategy: { async requestSessionSwap() {} }, runtimeDirectory: metadata.path, runtimeMetadata: metadata,
      machineId: 'machine', memoryRecallGuidanceEnabled: false, policyAgentId: 'codex',
      setActiveAgentCompositionToolSelection() {}, happyMcpServerStop() {}, reconnectionHandle: null, startupCoordinator: null,
      runtimeState, setAbortRequestedCallback() {},
      transitionModelSelection: async selection => ({ ok: true, status: 'already_active', activeSelection: selection }),
      initialResumeId: '',
      deps: {
        runPermissionModePromptLoopFn: input => runPermissionModePromptLoop({ ...input, shouldExit: () => ready, getAbortSignal: () => controller.signal }),
        sendReadyWithPushNotificationFn: async input => {
          readyPreviews.push(input.assistantPreviewText);
          thinkingAtReady.push(runtimeState.thinking);
          if (providerDispatchCount > 0) emit({ kind: 'turn-complete', turnId: `provider-successor-${providerDispatchCount}` });
          if (readyPreviews.length === 1) {
            secondHostSeq = ++observedSeq;
            queue.push({ text: 'second host input', localId: 'host-input-2', userMessageSeq: secondHostSeq }, { permissionMode: 'default' });
          } else {
            ready = true;
            controller.abort();
          }
        },
      },
    };
    try {
      await runSessionLoopLifecycle(params);
      expect(providerDispatchCount, JSON.stringify({ committedMessages, accountRequests })).toBe(2);
      expect.soft(readyPreviews).toEqual([hostAnswer, secondHostAnswer]);
      expect.soft(thinkingAtReady).toEqual([true, true]);
      expect(runtimeState.thinking).toBe(false);
    } finally {
      await lease.release();
      accountGet.mockRestore();
      accountPost.mockRestore();
    }
  });
});
