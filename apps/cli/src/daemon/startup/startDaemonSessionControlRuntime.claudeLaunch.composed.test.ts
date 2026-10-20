import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { decodeRunnerDaemonPluginServiceWireValueV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { prepareRunnerDaemonPluginServices } from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { authorizeResolvedAgentNativeExecLaunchForHost, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand } from '@happier-dev/cli-common/processInstance';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private HTTP listener is the transport boundary. Its production dispatcher,
// installed finite registration, requester custody and Exec remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

it('authorizes a fresh-folder Claude launch while the same requester has slow Claude credential materialization', async () => {
  // Requester materialization uses the production daemon singleton. This one
  // fixture owns its lifetime; per-case fixtures retain separate controllers.
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'claude', true, undefined, pluginReloadController);
  const account = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'claude-account' };
  const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
    ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null, metadata: { scopes: [] },
    content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { accessToken: 'fixture-access', expiresAtMs: '2000000000000',
        scopes: '["user:inference","user:sessions:claude_code"]', subscriptionType: 'pro', rateLimitTier: 'default' } },
      randomBytes: length => new Uint8Array(length) }),
  });
  let holdCredentials = false;
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  let releaseCredentials!: () => void;
  const released = new Promise<void>(resolve => { releaseCredentials = resolve; });
  const homeGet = vi.mocked(axios.get).getMockImplementation()!;
  // Delay only Home's credential HTTP boundary. Requester currentness, the real
  // bundled Claude callback and its materialization revision guards stay real.
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    if (new URL(String(url)).pathname === '/v4/connect/qualified/credential') {
      if (holdCredentials) { readStarted(); await released; }
      return { status: 200, data: credential };
    }
    return homeGet(url, config);
  });
  let materializationSettled = false;
  const materialization = h.requester.qualifiedConnectedAccountEstablishedRuntimeOwner.invokeWithReceipt({
    account, signal: h.signal, operation: { kind: 'materialize', request: { kind: 'files', fileIds: ['.credentials.json'] } },
    beforeInvoke: () => { holdCredentials = true; },
  }).finally(() => { materializationSettled = true; });
  const materialized = expect(materialization).resolves.toMatchObject({ result: { kind: 'files',
    files: { '.credentials.json': expect.any(Uint8Array) } } });
  try {
    await Promise.race([started, materialized]);
    const local = createUnavailablePluginServices();
    const services = await prepareRunnerDaemonPluginServices({ invocationId: 'cold-invocation', signal: h.signal,
      dispatch: async operation => {
        const response = await h.dispatch(operation);
        if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
        if (response.result.kind !== 'plugin_services.result_v1') throw new Error('Missing daemon service result');
        return decodeRunnerDaemonPluginServiceWireValueV1(response.result.value);
      }, local });
    const launch = await authorizeResolvedAgentNativeExecLaunchForHost(services.exec, {
      command: '/installed/claude', args: ['--session-id', 'native-session'], cwd: h.cwd, env: {},
    }, h.signal, issueAgentNativeLaunchQualifierForHost(services.exec));
    expect(launch).toMatchObject({ command: '/installed/claude', cwd: h.cwd, env: {} });
    expect(h.nativeEffects()).toBe(0);
    expect(materializationSettled).toBe(false);
    await launch.release();
    await h.dispatch({ kind: 'plugin_services.close_v1', ...h.operationBase() });
  } finally {
    releaseCredentials();
    await materialized;
  }
}, 120_000);


it('refuses a second entry for a tracked Claude conversation through the production spawn dispatcher', async () => {
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, 'claude');
  h.tracked.vendorResumeId = 'live-conversation';
  const identity = await readProcessIdentityByPid(process.pid);
  if (!identity || identity.processStartTimeMs === undefined || !('command' in identity)) throw new Error('Missing real runner process identity');
  h.tracked.processStartTimeMs = identity.processStartTimeMs;
  h.tracked.processCommandHash = hashProcessCommand(identity.command);
  const control = boundary.control;
  if (!control) throw new Error('Missing production spawn dispatcher');
  const result = await control.spawnSession({
    directory: h.cwd, resume: 'live-conversation',
    backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' },
  });
  expect(result).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
  expect(h.nativeEffects()).toBe(0);
}, 120_000);
