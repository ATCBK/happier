import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { accountSettingsParse } from '@happier-dev/protocol';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RegisteredSessionStateFieldMutationV1 } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import * as persistence from '@/persistence';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { createHappierMcpServer } from './createHappierMcpServer';

describe('createHappierMcpServer goal parity', () => {
  let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

  beforeAll(async () => {
    pluginRuntime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] },
    });
  });

  afterAll(async () => await pluginRuntime?.dispose());
  afterEach(() => vi.restoreAllMocks());

  it('routes a Claude goal Action through the canonical durable work-state owner', async () => {
    const sessionId = 'claude-goal-action-session';
    const queued: RegisteredSessionStateFieldMutationV1[] = [];
    const metadata = createTestMetadata({ flavor: 'claude', machineId: 'machine-1', path: '/repo' });
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({
      ...await persistence.readSettings(),
      machineId: 'machine-1',
    });
    const app = fastify();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: 'https://test-home.example.test' });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.get('/v2/sessions/:sessionId', async () => ({ session: createSessionRecordFixture({
      id: sessionId,
      active: false,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    }) }));
    const runtime = createHappierMcpServer({
      sessionId,
      getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {},
      getMetadataSnapshot: () => metadata,
      getCurrentSessionLocation: () => ({ machineId: 'machine-1', path: '/repo' }),
      enqueueRegisteredSessionStateFieldMutation: async (mutation) => { queued.push(mutation); },
      getWorkDepth: () => 0,
      getHostTurnWorkDepth: (turnId) => turnId === 'goal-turn' ? 0 : undefined,
      getActiveTurnPermissionWitness: () => ({
        turnId: 'goal-turn',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
      }),
    }, {
      credentials: { token: 'claude-goal-account', encryption: null },
      accountSettings: accountSettingsParse({}),
    });
    try {
      const result = await runtime.executeTool({
        toolName: 'session_goal_set',
        args: { objective: 'Ship owner parity' },
      });
      expect(result).toMatchObject({ ok: true, result: { status: 'applied' } });
      expect(queued).toEqual([
        expect.objectContaining({
          sessionId,
          fieldId: 'runtime.workState',
          source: 'daemon',
          deliveryClass: 'durable_required',
          op: expect.objectContaining({
            kind: 'set',
            value: expect.objectContaining({
              items: [expect.objectContaining({ kind: 'goal', title: 'Ship owner parity' })],
            }),
          }),
        }),
      ]);
    } finally {
      await runtime.mcp.close();
      restoreHttp();
      await app.close();
    }
  });
});
