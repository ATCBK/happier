import { expect, it, vi } from 'vitest';
import { Server, type Socket } from 'socket.io';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { MemorySettingsV1Schema } from '@happier-dev/protocol/memory/memorySettings';
import { MemoryStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { forwardRpcCall } from '../../../../../server/sources/app/api/socket/rpc/forwardRpcCall';
import { buildRpcMethodRoom } from '../../../../../server/sources/app/api/socket/rpc/rpcMethodRoom';

// No persistence is needed for this transport-only relay. Fail if it is used.
vi.mock('../../../../../server/sources/storage/db', () => ({ db: { machine: {
  findFirst: async () => { throw new Error('Unexpected database access'); },
} } }));

it.each(['memory.status', 'search.settings.get'] as const)(
  'preserves forwarded daemon and discovery failures through the real %s Action', async actionId => {
    const machineId = 'missing-memory-machine';
    const method = actionId === 'memory.status' ? RPC_METHODS.DAEMON_MEMORY_STATUS : RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET;
    const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger() {} });
    const io = new Server();
    // Socket delivery is the boundary; the relay and missing-handler producer stay real.
    const target = { id: 'daemon', connected: true, data: { clientType: 'user-scoped' },
      timeout: () => ({ emitWithAck: async (_event: string, request: Parameters<typeof manager.handleRequest>[0]) =>
        await manager.handleRequest(request) }) };
    io.sockets.sockets.set(target.id, target as unknown as Socket);
    io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: 'owner', method: `${machineId}:${method}` }), new Set([target.id]));
    const credentials = { token: 'plain-token', encryption: null };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'cli-global', mode: 'plain', ctx: null, machineActionDirectTargetTransport: {
        machineId, invoke: async (method, request) => {
          const response = await forwardRpcCall({ io, targetUserId: 'owner', method: `${machineId}:${method}`, callParams: request });
          if (!response.ok) throw createRpcCallError(response);
          return response.result;
        },
      } }));
    try {
      expect(await executor.execute(actionId, { machineId }, { surface: 'cli', authority: 'present_user' }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      const receipt = actionId === 'search.settings.get' ? MemorySettingsV1Schema.parse({ v: 1 })
        : MemoryStatusV1Schema.parse({ v: 1, enabled: false, indexMode: 'deep', hintsIndexReady: false,
          deepIndexReady: false, activeIndexReady: false, embeddingsEnabled: false, embeddingsMode: 'disabled',
          embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null,
          embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
          tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null });
      manager.registerHandler(method, async () => receipt);
      expect(await executor.execute(actionId, { machineId }, { surface: 'cli', authority: 'present_user' }))
        .toEqual({ ok: true, result: receipt });
      io.sockets.sockets.clear();
      const fetchSockets = vi.spyOn(io.sockets.adapter, 'fetchSockets').mockRejectedValue(new Error('cluster timeout'));
      try {
        expect(await executor.execute(actionId, { machineId }, { surface: 'cli', authority: 'present_user' }))
          .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
      } finally { fetchSockets.mockRestore(); }
    } finally { io.sockets.sockets.clear(); }
  },
);
