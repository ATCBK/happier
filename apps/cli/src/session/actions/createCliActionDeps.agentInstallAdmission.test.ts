import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { registerMachineAgentInstallJobRpcHandlers } from '@/api/machine/rpcHandlers.agentInstallJobs';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { resolveAcpLaunch } from '@/agent/acp/catalog/configured/resolveAcpLaunch';
import { createCliActionDeps } from './createCliActionDeps';
import * as persistence from '@/persistence';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const io = vi.hoisted(() => vi.fn());
// Network and the package-manager child are system boundaries; keep the Action,
// registered handler, job owner, staging, bin resolution and promotion real.
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it('replays local configured-Agent install, status, cancellation and removal through current Machine admission', async () => {
  const home = await createTempDir('happier-agent-install-admission-');
  const pnpm = join(home, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  await writeFile(pnpm, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  await chmod(pnpm, 0o755);
  const env = { ...process.env, HAPPIER_HOME_DIR: home, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath };
  const definition = AcpBackendDefinitionV1Schema.parse({ id: 'registry-agent', name: 'registry-agent', title: 'Registry Agent',
    launch: { kind: 'npm', package: '@fixture/acp', version: '2.2.2' }, createdAt: 1, updatedAt: 1 });
  const owner = createAgentInstallJobOwner({ accountId: 'alice', env, readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId }] }),
    readAcpCatalog: () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: [definition] } }),
    installerDeps: { execFileWithDeadline: async (_command, args) => {
      const workspace = args[1]!;
      await mkdir(join(workspace, 'node_modules', '@fixture', 'acp'), { recursive: true });
      await writeFile(join(workspace, 'node_modules', '@fixture', 'acp', 'package.json'), JSON.stringify({
        name: '@fixture/acp', version: '2.2.2', bin: { acp: 'cli.js' },
      }));
      await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
      const bin = join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'acp.cmd' : 'acp');
      await writeFile(bin, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
      await chmod(bin, 0o755);
      return { stdout: '', stderr: '' };
    } },
  });
  const manager = new RpcHandlerManager({ scopePrefix: 'selected', encryptionMode: 'plain', logger: () => {} });
  registerMachineAgentInstallJobRpcHandlers({ rpcHandlerManager: manager, owner });
  let current = true;
  const admitted: RpcHandlerContext = { signal: new AbortController().signal,
    machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'selected',
      installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => current };
  // The transport boundary supplies the same admission context as authenticated
  // ingress. The actual same-process shortcut below intentionally has none.
  const handlers: RpcHandlerMap = Reflect.get(manager, 'handlers');
  bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
    if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
      || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Unexpected transport');
    const handler = handlers.get(payload.method);
    if (!handler) throw new Error('Missing registered install handler');
    return { ok: true, result: await runWithServerHttpBaseUrl('https://home.invalid', () => handler(payload.params, admitted)) };
  } }));
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.fixture`, encryption: null };
  const serverHttpBaseUrl = 'https://home.invalid';
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials)) });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/acp') return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, definitions: [definition] } } } };
    return { status: 200, data: { machine: { id: 'selected', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } };
  });
  const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: '',
    serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: { machineId: 'selected', invoke: (method, request, options) => manager.invokeLocal(method, request, options) },
  }));
  const context = { surface: 'cli', authority: 'present_user', serverId: 'home', bypassApprovals: true } as const;
  try {
    const start = await executor.execute('machines.agents.install', { machineId: 'selected', agentId: 'custom-acp',
      definitionId: definition.id, intent: 'install', consent: { vendorRecipe: false } }, context);
    expect(start, JSON.stringify(start)).toMatchObject({ ok: true });
    if (!start.ok) throw new Error('Install was not admitted');
    assertActionOutputContract('machines.agents.install', start.result);
    const started = DaemonAgentInstallStartResponseSchema.parse(start.result);
    if (!started.ok) throw new Error('Install job missing');
    const { jobId } = started;
    await vi.waitFor(() => expect(owner.read({ jobId, cursor: 0 }, 'alice')).toMatchObject({ done: true, outcome: { kind: 'succeeded', version: '2.2.2' } }));
    const status = await executor.execute('machines.agents.install.status', { machineId: 'selected', jobId }, context);
    expect(status, JSON.stringify(status)).toMatchObject({ ok: true, result: { done: true, outcome: { kind: 'succeeded' } } });
    if (status.ok) assertActionOutputContract('machines.agents.install.status', status.result);
    await expect(resolveAcpLaunch({ accountId: 'alice', definition, env, platform: process.platform, arch: process.arch })).resolves.toMatchObject({ kind: 'ready' });
    const cancelled = await executor.execute('machines.agents.install.cancel', { machineId: 'selected', jobId }, context);
    expect(cancelled).toMatchObject({ ok: true });
    if (cancelled.ok) assertActionOutputContract('machines.agents.install.cancel', cancelled.result);
    current = false;
    await expect(executor.execute('machines.agents.install.status', { machineId: 'selected', jobId }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    current = true;
    const removed = await executor.execute('machines.agents.uninstall', { machineId: 'selected', agentId: 'custom-acp', definitionId: definition.id }, context);
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
    if (!removed.ok) throw new Error('Removal was not admitted');
    const removedJob = DaemonAgentInstallStartResponseSchema.parse(removed.result);
    if (!removedJob.ok) throw new Error('Removal job missing');
    await vi.waitFor(() => expect(owner.read({ jobId: removedJob.jobId, cursor: 0 }, 'alice')).toMatchObject({ done: true, outcome: { kind: 'succeeded' } }));
    await expect(resolveAcpLaunch({ accountId: 'alice', definition, env, platform: process.platform, arch: process.arch })).resolves.toMatchObject({ kind: 'needs_install' });
  } finally {
    await owner.shutdown();
    await removeTempDir(home);
  }
});
