import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import {
  AccountEncryptionCurrentnessResponseSchema,
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));

describe('happier session voice-agent start (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  const invokedActions: string[] = [];
  const backendTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
  let backendTargetKey = '';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-voice-agent-start-');
    invokedActions.length = 0;

    const sessionId = 'sess_integration_voice_agent_start_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64Session(
      encryptWithDataKey({ path: '/tmp', flavor: 'claude', machineId: 'machine-integration-voice' }, dek),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');
    // Keep the original encryption bootstrap order before loading the daemon's
    // Action transport declarations, which also consume the public catalog.
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    const { writeDaemonState } = await import('@/persistence');
    const { PLUGIN_ACTION_EXECUTE_PATH } = await import('@/plugins/daemon/controlRoutes');
    const { ExecutionRunStartRequestSchema } = await import('@happier-dev/protocol/execution/runs/startRequest');
    const { buildBackendTargetKeyV2 } = await import('@happier-dev/protocol/backends/targets/backendTargetRefV2');
    backendTargetKey = buildBackendTargetKeyV2(backendTarget);

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'POST' && url.pathname === PLUGIN_ACTION_EXECUTE_PATH) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request: unknown = JSON.parse(body);
        if (!request || typeof request !== 'object' || !('input' in request) || !('actionId' in request)) {
          throw new Error('Expected daemon Action request');
        }
        expect(request.actionId).toBe('action.options.resolve');
        const spec = getActionSpec('action.options.resolve');
        if (!spec.outputSchema) throw new Error('Expected a declared Action output schema');
        expect(spec.inputSchema.parse(request.input)).toMatchObject({ sessionId, optionsSourceId: 'execution.backends.enabled' });
        invokedActions.push('action.options.resolve');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ matched: true, result: { ok: true, result: spec.outputSchema.parse({
          actionId: 'voice_agent.start', fieldPath: 'backendTargetKeys', optionsSourceId: 'execution.backends.enabled',
          options: [{ value: backendTargetKey, label: 'Claude' }],
        }) } }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/account/encryption/currentness') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({
          mode: 'e2ee', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1,
        })));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: true,
              activeAt: 2,
              machineId: 'machine-integration-voice',
              metadata: metadataCiphertext,
              metadataVersion: 0,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: dataEncryptionKeyBase64,
              share: null,
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
    writeDaemonState({
      pid: process.pid, httpPort: address.port, startedAt: Date.now(),
      startedWithCliVersion: 'test', controlToken: 'voice-integration-control',
    });
    mockIo.mockReset();
    const { socketRpcCodec } = await import('@happier-dev/sync-client');
    const { resolveSessionRpcContent } = await import('@/session/transport/rpc/sessionRpc');
    const rpcContent = resolveSessionRpcContent({
      ctx: { encryptionKey: dek, encryptionVariant: 'dataKey' },
    });
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, request) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (!request || typeof request !== 'object' || !('params' in request)
          || typeof request.params !== 'string' || !('method' in request) || typeof request.method !== 'string') {
          throw new Error('Expected encrypted Session RPC');
        }
        const decoded = await socketRpcCodec.decodeRequestParams(rpcContent, request.params, request.method);
        const start = ExecutionRunStartRequestSchema.parse(decoded.params);
        expect(start).toMatchObject({
          intent: 'voice_agent', runClass: 'long_lived', ioMode: 'streaming',
        });
        expect(start.backendTarget).toEqual(backendTarget);
        expect(start.intentInput).toBeUndefined();
        invokedActions.push('voice_agent.start');
        return { ok: true, result: await socketRpcCodec.encodeResponse(rpcContent, {
          runId: 'run_1', callId: 'call_1', sidechainId: 'call_1',
        }, decoded.callId) };
      },
    }));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('returns a session_voice_agent_start JSON envelope with per-backend results', async () => {
    const { handleSessionCommand } = await import('../handleSessionCommand');

    const output = captureConsoleJsonOutput();

    try {
      const machineKeySeed = new Uint8Array(32).fill(8);
      await handleSessionCommand(
        [
          'voice-agent',
          'start',
          'sess_integration_voice_agent_start_123',
          '--backends',
          'claude',
          '--instructions',
          'Voice.',
          '--json',
        ],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'dataKey',
              publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
              machineKey: machineKeySeed,
            },
          }),
        },
      );

      const parsed = output.json();
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(parsed.kind).toBe('session_voice_agent_start');
      expect(parsed.data?.sessionId).toBe('sess_integration_voice_agent_start_123');
      expect(parsed.data?.results?.length).toBe(1);
      expect(parsed.data?.results?.[0]?.key).toBe(backendTargetKey);
      expect(parsed.data?.results?.[0], JSON.stringify(parsed.data?.results?.[0])).toMatchObject({
        ok: true, result: { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' },
      });
      expect(invokedActions).toEqual(['action.options.resolve', 'voice_agent.start']);
    } finally {
      output.restore();
    }
  });
});
