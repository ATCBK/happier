import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { WorkspaceSyncStatusV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { handleActionsCommand } from './actions';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
// Socket.IO and HTTP are the boundaries; CLI parsing, catalog, admission,
// exact-Machine routing and strict output validation execute unchanged.
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

it('executes Sync lifecycle from the CLI through the shared Action owner and exact controller', async () => {
  const status = WorkspaceSyncStatusV1Schema.parse({ relationshipId: 'copy-link', controllerMachineId: 'controller',
    state: 'watching', alphaPath: '/source', betaPath: '/copy', mode: 'keep_both_in_sync',
    endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: 1 });
  const cases = [
    { actionId: 'workspace.sync.relationship.disable', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE,
      result: { v: 1, relationshipId: 'copy-link', enabled: false } },
    { actionId: 'workspace.sync.relationship.enable', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME,
      result: { v: 1, relationshipId: 'copy-link', enabled: true } },
    { actionId: 'workspace.sync.relationship.flush', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
      result: { v: 1, relationshipId: 'copy-link', status } },
    { actionId: 'workspace.sync.relationship.terminate', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE,
      result: { v: 1, relationshipId: 'copy-link', terminated: true } },
  ] as const;
  const serverId = 'sync-cli-home';
  const serverHttpBaseUrl = 'https://sync-cli.test';
  const credentials = { token: 'sync-cli-fixture', encryption: null };
  const input = { controllerMachineId: 'controller', relationshipId: 'copy-link' };
  const requests: unknown[] = [];
  io.mockImplementation(() => createApiSessionSocketStub({ emitWithAck(event, raw) {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    requests.push(raw);
    return { ok: true, result: { ok: true, status } };
  } }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    expect(url).toBe(`${serverHttpBaseUrl}/v1/machines/controller`);
    return { status: 200, data: { machine: { id: 'controller', kind: 'persistent', storageMode: 'plain',
      dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null } } };
  });
  let enabled = true;
  const settings = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
    actions: enabled ? {} : { 'workspace.sync.relationship.flush': { enabled: false } },
    approvalWaivedSurfaces: Object.fromEntries(cases.map(({ actionId }) => [actionId, ['cli']])) }), getAccountSettings: () => null };
  const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
    serverId, serverHttpBaseUrl, actionsSettingsProvider: settings, pluginActionExecutionOwner: 'current_process' });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  for (const { actionId, method, result } of cases) {
    output = '';
    await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input), '--json'], {
      readCredentialsFn: async () => credentials,
      createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
    });
    expect(JSON.parse(output), output).toMatchObject({ ok: true, kind: 'actions_invoke', data: result });
    expect(requests.at(-1)).toMatchObject({ method: `controller:${method}`, params: { relationshipId: input.relationshipId } });
  }
  enabled = false;
  const before = requests.length;
  output = '';
  await handleActionsCommand(['invoke', 'workspace.sync.relationship.flush', '--input-json', JSON.stringify(input), '--json'], {
    readCredentialsFn: async () => credentials,
    createExecutorFn: () => ({ ...executor, resolveSessionTarget: async sessionId => ({ ok: true as const, sessionId }) }),
  });
  expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'action_disabled' } });
  expect(requests).toHaveLength(before);
});
