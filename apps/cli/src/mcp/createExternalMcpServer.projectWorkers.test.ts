import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { getActionSpec, ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createExternalMcpServer } from './createExternalMcpServer';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
// HTTP and Socket.IO are the system boundaries; the standalone MCP server,
// Action admission, Machine routing and result validation remain real.
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('standalone MCP worker Action composition', () => {
  it('keeps Machine status and Sync inspection alongside Account preferences through action_execute', async () => {
    const serverId = configuration.activeServerId;
    const serverHttpBaseUrl = 'https://standalone-worker-mcp.test';
    const credentials = { token: 'standalone-worker-fixture', encryption: null, credentialProvenance: 'stored_session' } as const;
    await writeStoredCredentialsForServerId(serverId, credentials);
    const example = ProjectWorkerActionInputSchemasV1['projects.worker.copy.inspect'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.inspect').examples!.voice!.argsExample!),
    );
    const workspace = { ...example.workspace, serverId };
    const inspect = { ...example, workspace };
    const preview = { ok: true, preview: { targetMachineId: inspect.targetMachineId,
      workspaceRefId: inspect.targetWorkspaceRefId, rootFingerprint: 'd'.repeat(64), sizeBytes: 24 } };
    const status = ProjectWorkerActionInputSchemasV1['projects.worker.status'].parse({
      workspace, destination: { kind: 'machine', machineId: 'worker' }, purpose: 'finite',
    });
    const statusResult = { eligible: true, candidate: { serverId, machineId: 'worker' },
      load: { kind: 'unknown' }, explanation: 'load_unknown' };
    let statusResponse: unknown = statusResult;
    const machineRequests: unknown[] = [];
    io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck(event, payload) {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      machineRequests.push(payload);
      if (payload.method === 'worker:projects.worker.status') return { ok: true, result: statusResponse };
      expect(payload.method).toBe(`${inspect.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`);
      return { ok: true, result: preview };
    } }));
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const machineId = String(url).split('/').at(-1);
      expect(['worker', inspect.machineId]).toContain(machineId);
      return { status: 200, data: { machine: { id: machineId, kind: 'persistent', storageMode: 'plain',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (config.url === `${serverHttpBaseUrl}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      expect(config.url).toBe(`${serverHttpBaseUrl}/v1/projects/execution/config/read`);
      expect(config.data).toEqual({ address: workspace });
      return { status: 200, data: { status: 'absent' } };
    });
    const { mcp } = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createExternalMcpServer({ credentials, machineId: 'source' }));
    const client = new Client({ name: 'standalone-worker-test', version: '1' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const invoke = async (actionId: string, input: unknown) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
      const content = result.content.find(entry => entry.type === 'text');
      if (!content || content.type !== 'text') throw new Error('Missing MCP Action result');
      return { isError: result.isError === true, value: JSON.parse(content.text) as unknown };
    };
    try {
      expect(await invoke('projects.worker.status', status)).toEqual({ isError: false, value: statusResult });
      expect(await invoke('projects.worker.copy.inspect', inspect)).toEqual({ isError: false, value: preview });
      expect(await invoke('projects.worker.preferences.get', { workspace }))
        .toMatchObject({ isError: false, value: { status: 'ready', revision: 'absent' } });
      expect(machineRequests).toEqual([
        expect.objectContaining({ method: 'worker:projects.worker.status', params: status }),
        expect.objectContaining({ method: `${inspect.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params: inspect }),
      ]);
      statusResponse = { ...statusResult, candidate: { serverId, machineId: 'another-worker' } };
      expect(await invoke('projects.worker.status', status))
        .toMatchObject({ isError: true, value: { errorCode: 'invalid_action_output' } });
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
