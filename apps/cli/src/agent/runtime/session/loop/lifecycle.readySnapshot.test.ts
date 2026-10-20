import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol';
import { createSessionProviderInputOutcomeBinding } from '@/agent/runtime/session/input/providerInputOutcome';

import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createUnsettledReplaySeedRetirement } from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import { extractAssistantTextSnapshotFromAcpMessage } from '@/api/session/turns/extractAssistantTextSnapshot';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { sendReadyWithPushNotification } from '@/agent/runtime/notifications/sendReadyWithPushNotification';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

import { HOST_SESSION_RUNTIME_PLAN_KIND, runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';

describe('host ready after a provider successor starts', () => {
  it.each([
    { hostAnswer: 'HOST_ANSWER', eagerStartup: false },
    { hostAnswer: null, eagerStartup: false },
    { hostAnswer: 'HOST_ANSWER', eagerStartup: true },
  ])('preserves the completed host preview and eager startup $eagerStartup/$hostAnswer', async ({ hostAnswer, eagerStartup }) => {
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
    const hostTurnIds: string[] = [];
    const readyOriginals: Array<{ localId: string; seq: number }> = [];
    const readyEvents: unknown[] = [];
    const sentNotifications: unknown[][] = [];
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    let providerDispatchCount = 0;
    const secondHostAnswer = hostAnswer === null ? 'SECOND_HOST_ANSWER' : null;
    const committedMessages: unknown[] = [];
    const terminalMutations: unknown[] = [];
    const committedAssistantSeqs = new Map<string, number>();
    const acceptedUserSeqs = new Map<string, number>();
    const pendingReceipts = new Map<string, () => void>();
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const emit = (input: Readonly<Record<string, unknown>>) => {
      const event = AgentSessionRuntimeEventV1Schema.parse({ ...input, sessionId, sequence: ++sequence, emittedAtMs: sequence });
      for (const listener of listeners) listener(event);
    };
    const startupEvents = eagerStartup ? [
      { kind: 'transcript-message-committed', messageId: 'startup-input', role: 'user', text: 'EXTENSION_STARTUP_INPUT' },
      { kind: 'turn-start', turnId: 'startup-turn', startedBy: 'provider' },
      { kind: 'message-delta', turnId: 'startup-turn', channel: 'assistant', text: 'EXTENSION_STARTUP_ANSWER' },
      { kind: 'turn-complete', turnId: 'startup-turn' },
      { kind: 'provider-session-id', providerSessionId: 'startup-native-session' },
    ].map(input => AgentSessionRuntimeEventV1Schema.parse({ ...input, sessionId, sequence: ++sequence, emittedAtMs: sequence })) : [];
    // The vendor runtime is the external boundary. Native admission, transcript
    // projection, snapshot ownership, the prompt loop and ready dispatch are real.
    const provider: AgentSessionRuntime = {
      async send(request) {
        providerDispatchCount += 1;
        hostTurnIds.push(request.delivery.turnId);
        const answer = providerDispatchCount === 1 ? hostAnswer : secondHostAnswer;
        emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
        if (answer) emit({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: answer });
        emit({ kind: 'turn-complete', turnId: request.delivery.turnId });
        const successorTurnId = `provider-successor-${providerDispatchCount}`;
        emit({ kind: 'turn-start', turnId: successorTurnId, startedBy: 'provider' });
        emit({ kind: 'transcript-message-committed', turnId: successorTurnId, messageId: `successor-answer-${providerDispatchCount}`,
          role: 'assistant', text: 'SUCCESSOR_ANSWER' });
        return { status: 'admitted' };
      },
      watch(listener) {
        listeners.add(listener);
        for (const event of startupEvents.splice(0)) listener(event);
        return { dispose() { listeners.delete(listener); } };
      },
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
      enqueueSessionEventCommitted: async (event: Parameters<NonNullable<typeof fixture.enqueueSessionEventCommitted>>[0]) => {
        if (event.type !== 'ready') return { persisted: true, delivered: true };
        readyEvents.push(event);
        const sourceMessage = { localId: `ready-original-${readyOriginals.length + 1}`, seq: ++observedSeq };
        readyOriginals.push(sourceMessage);
        return { persisted: true, delivered: true, localId: sourceMessage.localId, committedSequence: sourceMessage.seq,
          personalFollow: { sourceSessionId: sessionId, sourceMessage: { ...sourceMessage, policies: [{ preset: 'everything' as const }] } } };
      },
      turnAssistantTextSnapshotStore: snapshots,
      getTurnAssistantTextSnapshotStore: () => snapshots,
      getLastObservedMessageSeq: () => observedSeq,
      enqueueUserTextMessageCommitted: async (text: string) => {
        committedMessages.push({ role: 'user', text });
        observedSeq += 1;
        return { persisted: true as const, delivered: true as const };
      },
      getCommittedUserMessageSeq: (localId: string) => acceptedUserSeqs.get(localId) ?? null,
      enqueueSessionTurnMutation: async (mutation: unknown) => {
        const parsed = SessionTurnMutationV1Schema.parse(mutation);
        if (parsed.action === 'complete') terminalMutations.push(parsed);
      },
      enqueueAgentMessageCommitted: async (
        providerId: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[0],
        body: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[1],
        options: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[2],
      ) => {
        committedMessages.push(body);
        const extracted = extractAssistantTextSnapshotFromAcpMessage(providerId, body);
        if (extracted) {
          const seq = ++observedSeq;
          snapshots.observe({ ...extracted, localId: options.localId, seq, source: 'committed' });
          committedAssistantSeqs.set(extracted.text, seq);
          // The external Pending receipt can arrive after a successor's first
          // assistant row. Native acceptance itself is not this Home ACK.
          if (extracted.text === 'SUCCESSOR_ANSWER') {
            for (const settle of pendingReceipts.values()) settle();
            pendingReceipts.clear();
          }
        }
        return { persisted: true as const, delivered: true as const };
      },
    });
    const inputBinding = createSessionProviderInputOutcomeBinding({ getTarget: () => ({ sessionId,
      hasPendingProviderInput: () => true,
      observeProviderInputSettlement: outcome => new Promise<void>(resolve => {
        pendingReceipts.set(outcome.localId, () => {
          const seq = outcome.localId === 'host-input' ? 1 : secondHostSeq;
          if (seq !== null) acceptedUserSeqs.set(outcome.localId, seq);
          resolve();
        });
      }),
    }) });
    // These are the real host launch owners, installed before the Session loop.
    runtime.setOnPromptDeliveryOutcome(inputBinding.observeProviderInputOutcome);
    let metadataPublication: ReturnType<typeof subscribeSessionRuntimePublicationToMetadata> | null = null;
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
        loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false, formatPromptErrorMessage: String,
        lifecycleHooks: { createCheckpointLifecycle: () => ({}) },
        publishHostRuntimeEvent: event => metadataPublication?.observeRuntimeEvent(event),
      },
      api: { push: () => ({
        fetchSessionNotificationContext: async id => {
          const source = createSessionNotificationContextFixture(id);
          return { ...source, viewer: { ...source.viewer!, follow: { follows: true, notificationLevel: 'important' as const,
            policy: { preset: 'quiet' as const } } } };
        }, readAccountSessionDeliveryMutedScopes: async () => [],
        async sendToAllDevicesAsync(...args: unknown[]) { sentNotifications.push(args); return true; },
      }) },
      // The canonical Session fixture substitutes the server/persistence boundary.
      session: session as unknown as SessionLoopLifecycleParams['session'],
      runtime, hookRuntime: runtime, registerProviderAcceptedEffect: inputBinding.registerProviderAcceptedEffect, messageBuffer: new MessageBuffer(),
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
          expect(input.completedTurn).toEqual({ turnId: hostTurnIds[readyPreviews.length - 1] });
          await sendReadyWithPushNotification(input);
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
    let runtimeForLoop: SessionLoopLifecycleParams['runtime'] = runtime;
    if (eagerStartup) {
      const wrapped = withHostSessionRuntimeIdentityPublication({
        plan: { kind: HOST_SESSION_RUNTIME_PLAN_KIND, agentId: 'codex', opts: params.opts,
          config: { ...params.config, createSessionRuntime: () => ({ operations: runtime, nativeRuntime: runtime }) } },
        identity: { runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null },
      });
      // This native factory consumes no launch fields; the real host wrapper
      // and publication hub still execute, matching the canonical wrapper testkit.
      const created = await wrapped.config.createSessionRuntime?.({} as never);
      if (!created) throw new Error('Missing host runtime factory');
      runtimeForLoop = created.operations;
      metadataPublication = subscribeSessionRuntimePublicationToMetadata({
        session, sessionState: { writeHappierField: async () => ({ ok: true as const, version: 1 }) }, runtime: created.operations,
      });
    }
    try {
      await runSessionLoopLifecycle({ ...params, runtime: runtimeForLoop });
      expect(providerDispatchCount, JSON.stringify({ committedMessages, accountRequests })).toBe(2);
      for (const [index, answer] of [hostAnswer, secondHostAnswer].entries()) {
        expect(terminalMutations).toContainEqual(expect.objectContaining({ turnId: hostTurnIds[index],
          transcriptAnchors: expect.objectContaining({ startUserMessageSeq: index === 0 ? 1 : secondHostSeq,
            userMessageSeqs: [index === 0 ? 1 : secondHostSeq],
            finalAssistantMessageSeq: answer ? committedAssistantSeqs.get(answer) : null }) }));
      }
      expect.soft(readyPreviews).toEqual([hostAnswer, secondHostAnswer]);
      await vi.waitFor(() => expect(sentNotifications).toHaveLength(2));
      expect(readyEvents).toEqual(hostTurnIds.map(completedTurnId => ({ type: 'ready', ownerActivityDelivery: 'rich_sender', completedTurnId })));
      expect(sentNotifications.map(notification => notification[2])).toEqual(readyOriginals.map(original => ({
        sessionId, activityEventLocalId: original.localId,
        activityEvent: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: original.seq },
      })));
      expect.soft(thinkingAtReady).toEqual([true, true]);
      expect(runtimeState.thinking).toBe(false);
      expect(listeners.size).toBe(0);
      if (eagerStartup) {
        expect.soft(JSON.stringify(committedMessages)).toContain('EXTENSION_STARTUP_INPUT');
        expect.soft(JSON.stringify(committedMessages)).toContain('EXTENSION_STARTUP_ANSWER');
      }
    } finally {
      metadataPublication?.();
      await lease.release();
      accountGet.mockRestore();
      accountPost.mockRestore();
      clearActiveAccountSettingsSnapshot();
    }
  });
});
