import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import * as pinnedHttp from '@/network/pinnedHttp';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';


import {
  accountSettingsParse,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import type { AgentState } from '@/api/types';
import type { AgentStateRequestResponseTarget } from './agentStateRequestStore';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';

const fetchSessionNotificationContext = async (sessionId: string) => createSessionNotificationContextFixture(sessionId);

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: unknown = {
    summary: { text: 'Fix prod issue' },
    agentDisplayName: 'Codex',
  };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  async updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void> {
    this.updateAgentState(updater);
  }
}

class TestPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string {
    return '[Test]';
  }

  request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return this.requestPermissionDecision(toolCallId, toolName, input);
  }

  seedPendingRequest(
    toolCallId: string,
    toolName: string,
    input: unknown,
    metadata: Readonly<{
      responseTarget?: AgentStateRequestResponseTarget;
      subagentRef?: unknown;
      sidechainId?: string;
      permissionSuggestions?: readonly unknown[];
    }>,
  ): void {
    this.pendingRequests.set(toolCallId, {
      resolve: () => undefined,
      reject: () => undefined,
      toolName,
      input,
      ...(typeof metadata.responseTarget !== 'undefined' ? { responseTarget: metadata.responseTarget } : {}),
      ...(typeof metadata.subagentRef !== 'undefined' ? { subagentRef: metadata.subagentRef } : {}),
      ...(typeof metadata.sidechainId === 'string' ? { sidechainId: metadata.sidechainId } : {}),
      ...(Array.isArray(metadata.permissionSuggestions)
        ? { permissionSuggestions: metadata.permissionSuggestions }
        : {}),
    });
  }
}

describe('BasePermissionHandler push notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a permission-request push when enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const session = new FakeSession();
    const settings = accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });

    // Push is fire-and-forget; flush microtasks to observe the async send.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Fix prod issue',
      'Codex asks permission to use Write\nFile: /tmp/x',
      expect.objectContaining({ sessionId: 'session-test', requestId: 'perm-1' }),
      { sound: 'happier_urgent.wav', priority: 'high', androidSoundId: 'urgent' },
    );

    // Resolve to avoid dangling pending promises.
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });

  it('does not send when permission-request pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const session = new FakeSession();
    const settings = accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });

  it('dedupes repeated pending publications for the same request id', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const session = new FakeSession();
    const settings = accountSettingsParse({
        notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const input = { path: '/tmp/x', content: 'hi' };
    const p1 = handler.request('perm-1', 'Write', input);
    const p2 = handler.request('perm-1', 'Write', input);

    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await expect(p1).resolves.toMatchObject({ decision: 'denied' });
    await expect(p2).resolves.toMatchObject({ decision: 'denied' });
  });

  it('re-attempts permission-request push after a session swap while still pending', async () => {
    const sendToAllDevicesAsync = vi
      .fn(async () => { return true; })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(true);

    const session1 = new FakeSession();
    const session2 = new FakeSession();
    session2.sessionId = 'session-two';
    session2.rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(session2.sessionId);

    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const handler = new TestPermissionHandler(session1 as any, {
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);

    handler.updateSession(session2 as any);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);

    const rpc = session2.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });

  it('republishes pending requests with routing metadata after a session swap', () => {
    const session1 = new FakeSession();
    session1.agentState.requests['perm-1'] = {
      tool: 'Write',
      arguments: { path: '/tmp/x', content: 'hi' },
      createdAt: 123,
      turnId: 'turn-perm-1',
      responseTarget: {
        kind: 'test_target',
        requestOwner: 'owner-1',
      },
      subagentRef: {
        runId: 'run-1',
        callId: 'call-1',
      },
      sidechainId: 'sidechain-1',
      permissionSuggestions: [{ behavior: 'allow', tool: 'Write' }],
    };

    const session2 = new FakeSession();
    session2.sessionId = 'session-two';
    const handler = new TestPermissionHandler(session1 as any);
    handler.seedPendingRequest('perm-1', 'Write', { path: '/tmp/x', content: 'hi' }, {
      responseTarget: {
        kind: 'test_target',
        requestOwner: 'owner-1',
      },
      subagentRef: {
        runId: 'run-1',
        callId: 'call-1',
      },
      sidechainId: 'sidechain-1',
      permissionSuggestions: [{ behavior: 'allow', tool: 'Write' }],
    });

    handler.updateSession(session2 as any);

    expect(session2.agentState.requests['perm-1']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        arguments: { path: '/tmp/x', content: 'hi' },
        turnId: 'turn-perm-1',
        responseTarget: {
          kind: 'test_target',
          requestOwner: 'owner-1',
        },
        subagentRef: {
          runId: 'run-1',
          callId: 'call-1',
        },
        sidechainId: 'sidechain-1',
        permissionSuggestions: [{ behavior: 'allow', tool: 'Write' }],
      }),
    );
  });

  it('signs webhook notifications when account settings secrets read keys are provided', async () => {
    // The webhook's genuine network boundary is the pinned HTTP transport.
    const transport = vi.spyOn(pinnedHttp, 'openPinnedHttpStream').mockResolvedValue({
      status: 200, headers: {}, contentLength: 0, read: async () => null, cancel: () => {},
    });

    const settingsSecretsKey = deriveSettingsSecretsKeyV1(new Uint8Array(32).fill(9));
    const encryptedSigningSecret = encryptSecretStringV1(
      'qa-signing-secret',
      settingsSecretsKey,
      () => new Uint8Array(24).fill(7),
    );
    const session = new FakeSession();
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: false, ready: true, permissionRequest: true },
      notificationChannelsV1: [
        {
          v: 1,
          id: 'builtin:expo_push',
          kind: 'expo_push',
          enabled: false,
          topics: { ready: true, permissionRequest: true, userActionRequest: true },
          readyIncludeMessageText: false,
        },
        {
          v: 1,
          id: 'webhook-qa',
          kind: 'webhook',
          enabled: true,
          url: 'http://127.0.0.1:40123/webhook',
          signingSecret: {
            _isSecretValue: true,
            encryptedValue: encryptedSigningSecret,
          },
          topics: { ready: true, permissionRequest: true, userActionRequest: true },
          readyIncludeMessageText: false,
        },
      ],
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync: vi.fn(async () => { return true; }) },
      getAccountSettings: () => settings,
      getAccountSettingsSecretsReadKeys: () => [settingsSecretsKey],
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:40123/webhook',
        validatedAddresses: ['127.0.0.1'],
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-happier-signature-256': expect.stringMatching(/^sha256=/),
        }),
      }),
    );

    const request = transport.mock.calls[0]![0];
    expect(request.headers['x-happier-signature-256']).toBe(
      `sha256=${createHmac('sha256', 'qa-signing-secret').update(request.body!).digest('hex')}`,
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc?.({ id: 'perm-1', approved: false, decision: 'denied' });
    await promise;
  });
});
