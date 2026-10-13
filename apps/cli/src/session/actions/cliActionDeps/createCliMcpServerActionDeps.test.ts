import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { callSocketRpc } from '@happier-dev/sync-client';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { clearActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeferred } from '@/testkit/async/deferred';
import { createCliMcpServerActionExecuteV1 } from './createCliMcpServerActionDeps';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
const servers: Server[] = [];

afterEach(async () => {
  resetActiveAccountSettingsSnapshotForTests();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

describe('MCP Machine Action transport disposition', () => {
  it('lists generated facts only for Agents installed on current Account Machines, including offline Machines', async () => {
    const codec = createMachineContentCodec({ encryptionMode: 'plain' });
    let inventoryAvailable = true;
    const machine = (id: string, agentId: string, active: boolean, revokedAt: number | null = null) => ({
      id, active, revokedAt, replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: null,
      metadata: codec.encodeStored(MachinePublishedMetadataV1Schema.parse({ host: id, platform: 'linux',
        happyCliVersion: 'test', homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier',
        agentInventory: { checkedAt: 1, installedAgentIds: [agentId] } })),
    });
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      else if (request.url === '/v1/machines' && !inventoryAvailable) { response.statusCode = 503; response.end('{}'); }
      else if (request.url === '/v1/machines') response.end(JSON.stringify([
        machine('online', 'claude', true), machine('offline', 'kilo', false), machine('revoked', 'pi', false, 2),
      ]));
      else if (request.url === '/v1/account/entity-rows/mcp') response.end(JSON.stringify({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server', name: 'server', transport: 'stdio',
          stdio: { command: 'fixture', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }] } } }));
      else if (request.url === '/v1/account/entity-rows/profiles/transfer') response.end(JSON.stringify({ status: 'absent' }));
      else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
        callMachineAction: async () => { throw new Error('Tools list does not launch a Machine operation'); } });
      const receipt = await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' },
        context: { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } } });
      if (!receipt.ok) throw new Error(receipt.errorCode);
      const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
      expect(listed.perAgent.agents).toEqual([
        { agentId: 'claude', off: 'hidden', approval: 'host', loading: 'every_turn', tokens: null },
        { agentId: 'kilo', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
      ]);
      inventoryAvailable = false;
      expect(await execute({ actionId: 'mcp.servers.tools.list', input: { serverId: 'server' },
        context: { surface: 'cli', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' } } }))
        .toMatchObject({ ok: true, result: { perAgent: { status: 'unavailable', agents: [] } } });
    });
  });
  it('reports an issued cancelled process test as unknown, not as an unexecuted cancellation', async () => {
    const base = 'https://mcp-machine.example.test';
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const issued = createDeferred<void>();
      const reply = createDeferred<unknown>();
      const controller = new AbortController();
      const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
          // Socket emit is the replaced boundary. The real request-correlated
          // cancellation/disposition owner remains beneath the Action adapter.
          callMachineAction: input => callSocketRpc({ target: { kind: 'machine', id: input.machineId },
            method: input.method, params: input.request, content: { mode: 'plain' }, signal: input.signal,
            randomBytes: length => new Uint8Array(length), socket: { connected: true, emit: () => {},
              emitWithAck: async () => { issued.resolve(); return reply.promise; } } }),
        });
      const pending = execute({ actionId: 'mcp.servers.test', input: { t: 'byId', machineId: 'exact-machine',
        directory: '/project', serverId: 'server' }, context: { surface: 'cli', authority: 'present_user',
        serverId: 'home', actionCaller: { kind: 'host' }, signal: controller.signal } });
      await issued.promise;
      controller.abort();
      expect(await pending).toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
      reply.resolve({ ok: true, result: { ok: true, toolCount: 1, durationMs: 1 } });
    });
  });
  it('retains an acknowledged process-test receipt but refuses probe content after Account retirement', async () => {
    const base = 'https://mcp-machine.example.test';
    await runWithServerHttpBaseUrl(base, async () => {
      const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'mcp-machine-account' })).toString('base64url')}.signature`, encryption: null };
      for (const actionId of ['mcp.servers.test', 'mcp.found.list'] as const) {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        const receipt = actionId === 'mcp.servers.test' ? { ok: true, toolCount: 1, durationMs: 1 }
          : { ok: true, servers: [] };
        const execute = createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: base,
            callMachineAction: async input => {
              const result = await callSocketRpc({ target: { kind: 'machine', id: input.machineId },
                method: input.method, params: input.request, content: { mode: 'plain' },
                randomBytes: length => new Uint8Array(length), socket: { connected: true, emit: () => {},
                  emitWithAck: async () => ({ ok: true, result: receipt }) } });
              // The transport has consumed its genuine ACK before the Account
              // retires; private read content and effect receipts differ here.
              clearActiveAccountSettingsSnapshot();
              return result;
            },
          });
        const input = actionId === 'mcp.servers.test' ? { t: 'byId', machineId: 'exact-machine', directory: '/project', serverId: 'server' }
          : { machineId: 'exact-machine', directory: '/project' };
        expect(await execute({ actionId, input, context: { surface: 'cli', authority: 'present_user', serverId: 'home',
          actionCaller: { kind: 'host' } } })).toEqual(actionId === 'mcp.servers.test'
          ? { ok: true, result: receipt } : { ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
      }
    });
  });
});
