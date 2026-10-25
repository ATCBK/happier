import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import * as pinnedHttp from '@/network/pinnedHttp';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';


import {
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';

import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import type { AgentState } from '@/api/types';
import type { AgentStateRequestResponseTarget } from './agentStateRequestStore';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';

const fetchSessionNotificationContext = async (sessionId: string) => createSessionNotificationContextFixture(sessionId);
// Source-session delivery fails closed without the Account's mute scopes; this Account has none.
const readAccountSessionDeliveryMutedScopes = async () => [];

function admitNotificationSettings(options: Parameters<typeof createNotificationAccountSnapshotFixture>[0] = {}) {
  const snapshot = createNotificationAccountSnapshotFixture(options);
  setActiveAccountSettingsSnapshot(snapshot);
  return snapshot.settings;
}

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
    clearActiveAccountSettingsSnapshot();
  });

  it('sends a permission-request push when enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const session = new FakeSession();
    const settings = admitNotificationSettings();
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });

    // Push is fire-and-forget; flush microtasks to observe the async send.
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
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
    const settings = admitNotificationSettings({ channels: [
      { v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: { permissionRequest: false } },
    ] });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes, sendToAllDevicesAsync },
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
    const settings = admitNotificationSettings();
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const input = { path: '/tmp/x', content: 'hi' };
    const p1 = handler.request('perm-1', 'Write', input);
    const p2 = handler.request('perm-1', 'Write', input);

    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));

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

    const settings = admitNotificationSettings();
    const handler = new TestPermissionHandler(session1 as any, {
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes, sendToAllDevicesAsync },
      getAccountSettings: () => settings,
    } as any);

    const promise = handler.request('perm-1', 'Write', { path: '/tmp/x', content: 'hi' });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));

    handler.updateSession(session2 as any);
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2));

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

  it('signs webhook notifications with the current encrypted Saved Secret resource', async () => {
    // The webhook's genuine network boundary is the pinned HTTP transport.
    const transport = vi.spyOn(pinnedHttp, 'openPinnedHttpStream').mockResolvedValue({
      status: 200, headers: {}, contentLength: 0, read: async () => null, cancel: () => {},
    });

    const resourceDataKey = new Uint8Array(32).fill(9);
    const session = new FakeSession();
    const settings = admitNotificationSettings({
      savedSecretCatalogState: 'ready',
      savedSecretResources: [{
        resourceId: 'webhook-signing', ownerAccountId: 'notification-fixture-account', displayName: 'Webhook signing',
        kind: 'token', encryptionMode: 'e2ee', revision: 1, materialStatus: 'ready', resourceDataKey,
        storedContent: sealSavedSecretResourceStoredContentV1({
          resourceId: 'webhook-signing', mode: 'e2ee', resourceDataKey,
          content: { v: 1, name: 'Webhook signing', kind: 'token', value: 'qa-signing-secret' },
          randomBytes: length => new Uint8Array(length).fill(7),
        }),
      }],
      channels: [
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
          signingSecretRef: 'happier:shared-secret:v1:webhook-signing',
          topics: { ready: true, permissionRequest: true, userActionRequest: true },
          readyIncludeMessageText: false,
        },
      ],
    });
    const handler = new TestPermissionHandler(session as any, {
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes, sendToAllDevicesAsync: vi.fn(async () => { return true; }) },
      getAccountSettings: () => settings,
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
