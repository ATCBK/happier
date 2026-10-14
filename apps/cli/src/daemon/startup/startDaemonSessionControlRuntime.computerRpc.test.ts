import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DaemonComputerActionExecuteResponseV1Schema } from '@happier-dev/protocol/computer/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createDaemonMachineRpcRouteAttachmentCache } from '../machineRpcRouteAttachments';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';

// The private control listener is an OS boundary; startup, route attachment,
// Machine registration, RPC dispatch and Computer admission remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));

it.each([true, false])('serves Computer RPC when the machine arrives after startup (capture registry=%s)', async withRegistry => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-computer-rpc-startup-'));
  let active: ApiMachineClient | null = null;
  const attachments = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => active });
  const fixture = await createRequesterSessionControlRuntimeFixture({
    happyHomeDir: join(directory, 'home'), activeServerDir: join(directory, 'home', 'servers', 'computer-home'),
    serverId: 'computer-home', serverHttpBaseUrl: 'https://computer-home.invalid',
    machineId: 'machine-computer', custodianAccountId: 'owner', credentials: { token: 'computer-fixture', encryption: null },
    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
    registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
    resolveQualifiedConnectedAccountV4Support: () => 'advertised', getApiMachineForSessions: () => active,
    startup: {
      ...(withRegistry ? { liveStreamCaptureRegistry: createMachineLiveStreamCaptureRegistry() } : {}),
      onComputerRoutesReady: attachments.attachComputerRoutes,
    },
  });
  try {
    active = new ApiMachineClient('computer-fixture', { id: 'machine-computer', encryptionMode: 'plain',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    attachments.attachApiMachineForSessions(active);
    const manager: unknown = Reflect.get(active, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing machine RPC owner');
    const result = DaemonComputerActionExecuteResponseV1Schema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
      { sessionId: 'session-computer', actionId: 'computer.target.get', input: { machineId: 'machine-computer' } },
      { verifiedPeerAuthority: 'present_user' },
    )).result;
    expect(result).toEqual(withRegistry
      ? { consentGranted: false, approvalDisplay: { machineDisplayName: 'machine-computer', requiresTargetSelection: true } }
      : { ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' });
    await fixture.runtime.stopControlServer();
    expect(DaemonComputerActionExecuteResponseV1Schema.parse(await manager.invokeLocal(
      RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE,
      { sessionId: 'session-computer', actionId: 'computer.target.get', input: { machineId: 'machine-computer' } },
      { verifiedPeerAuthority: 'present_user' },
    )).result).toEqual({ ok: false, errorCode: 'computer_unavailable', error: 'computer_unavailable' });
  } finally {
    active?.shutdown();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
