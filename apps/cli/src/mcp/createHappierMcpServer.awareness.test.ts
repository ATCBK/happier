import axios from 'axios';
import {
  FeaturesResponseSchema,
  SessionAwarenessProjectionV1Schema,
  accountSettingsParse,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  createAccountEncryptionCurrentnessFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';

import { createHappierMcpServer } from './createHappierMcpServer';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createSessionDaemonAuthorityFixture } from './runtime/sessionDaemonAuthority.testkit';

vi.mock('axios', () => ({ default: { get: vi.fn(), isAxiosError: () => false } }));

describe('built-in Agent/MCP awareness Action', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes session.activity.get through the real MCP Action bridge against the captured Home', async () => {
    const sessionId = 'c123456789012345678901234';
    const homeUrl = 'http://lane09-agent-home.test';
    const token = 'lane09-agent-account-token';
    const now = Date.now();
    const requests: Array<Readonly<{ url: string; authorization: unknown }>> = [];
    const row = createSessionRecordFixture({
      id: sessionId,
      encryptionMode: 'plain',
      metadata: '{}',
      active: true,
      activeAt: now,
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: now,
    });

    vi.mocked(axios.get).mockImplementation(async (url, config) => {
      requests.push({
        url: String(url),
        authorization: config?.headers?.Authorization,
      });
      if (String(url) === `${homeUrl}/v2/sessions/${sessionId}`) {
        return { status: 200, data: { session: row } };
      }
      if (String(url) === `${homeUrl}/v1/account/encryption/currentness`) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const credentials = { token, encryption: null } as const;
    const executor = createCliActionExecutorFromCredentials({ credentials,
      serverId: 'lane09-agent-home', serverApiUrl: homeUrl, pluginActionExecutionOwner: 'current_process',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
      resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
    });
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId, execute: async operation =>
      await executor.execute(operation.actionId, operation.input, { surface: 'agent', authority: 'account_automation',
        defaultSessionId: sessionId, actionCaller: operation.witness.agentStartCaller }),
    });
    const result = await runWithServerHttpBaseUrl(homeUrl, async () => {
      const agentMcp = createHappierMcpServer({
        sessionId,
        getServerBinding: () => ({
          serverId: 'lane09-agent-home',
          serverUrl: homeUrl,
        }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
        updateMetadata: () => {},
        getWorkDepth: () => 0,
        getHostTurnWorkDepth: () => 0,
        getActiveTurnPermissionWitness: () => ({ turnId: 'awareness-turn',
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
        getActiveTurnAdmissionWitness: () => ({ turnId: 'awareness-turn', inputId: 'awareness-input',
          userMessageSeq: 1, userMessageSeqs: [1],
          agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
        getServerFeaturesSnapshot: () => ({
          status: 'ready' as const,
          provenance: 'authenticated' as const,
          features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true } },
            capabilities: { serverIdentity: { serverIdentityId: 'lane09-agent-home' } },
          }),
        }),
      }, {
        credentials,
        requiredDirectActionIds: ['session.activity.get'],
      });

      expect(agentMcp.toolNames).toContain('session_activity_get');
      try {
        return await agentMcp.executeTool({
          toolName: 'session_activity_get',
          args: { sessionId, view: 'awareness' },
          toolCallId: 'lane09-awareness-call',
        });
      } finally { await agentMcp.mcp.close(); }
    }).finally(() => daemon.close());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(SessionAwarenessProjectionV1Schema.safeParse(result.result).success).toBe(true);
    expect(result.result).toMatchObject({
      v: 1,
      sessionId,
      operational: { primary: 'working' },
    });
    expect(result.result).not.toHaveProperty('ok');
    expect(result.result).not.toHaveProperty('messageCounts');
    expect(requests).toEqual([
      { url: `${homeUrl}/v2/sessions/${sessionId}`, authorization: `Bearer ${token}` },
      { url: `${homeUrl}/v1/account/encryption/currentness`, authorization: `Bearer ${token}` },
    ]);
  });
});
