import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import axios from 'axios';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';

const home = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'host-initial-access-'));
  vi.stubEnv('HAPPIER_HOME_DIR', home);
  return home;
});

import { runHostSessionRuntime } from './runHostSessionRuntime';
import { configuration } from '@/configuration';
import { createSessionInitialAccessFile, consumeSessionInitialAccessFile } from '@/daemon/spawn/sessionInitialAccessFile';
import { buildHappySessionControlArgs } from '@/daemon/sessionSpawnArgs';
import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import { buildPluginHostSessionRuntimeOptions, buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';

beforeAll(async () => {
  // Persistent OS-boundary fixtures; bootstrap, catalog, metadata and API logic stay real.
  await writeFile(configuration.settingsFile, JSON.stringify({
    schemaVersion: 6,
    machineIdByServerId: { [configuration.activeServerId]: 'machine-1' },
  }));
  await mkdir(dirname(configuration.daemonStateFile), { recursive: true });
  await writeFile(configuration.daemonStateFile, JSON.stringify({
    pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'test',
  }));
});

afterAll(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

it.each([
  { primaryTeamId: 'team-1', placementOrigin: { kind: 'machine_pool' as const, poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f' } },
  { primaryTeamId: null, placementOrigin: undefined },
])('carries native host launch access, Team context $primaryTeamId and optional Pool origin to HTTP before any Agent runtime opens', async ({ primaryTeamId, placementOrigin }) => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    features: { sessions: { enabled: true }, sharing: { session: { enabled: true } } },
    capabilities: {
      accountStoredContentCompatibility: {
        v: 1, minimumProtocolVersion: 2, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
      },
      encryption: { storagePolicy: 'plaintext_only', allowAccountOptOut: false, defaultAccountMode: 'plain' },
    },
  }))));
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
    mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  } });
  const refusal = { code: 'session_access_sharing_unavailable', status: 409, retryable: false };
  vi.spyOn(axios, 'post').mockRejectedValue({ isAxiosError: true, response: { status: 409, data: { error: 'session_access_sharing_unavailable' } } });
  const initialAccess = { grants: [{ subject: { kind: 'team' as const, teamId: 'team-1' }, accessLevel: 'view' as const, canApprovePermissions: false }] };
  const file = await createSessionInitialAccessFile(home, initialAccess);
  const partition = partitionProviderSessionArgs({
    args: ['codex', '--started-by', 'daemon', ...buildHappySessionControlArgs({ initialAccessFilePath: file.path, primaryTeamId, placementOrigin, resume: 'provider-session' })],
    providerSubcommand: 'codex',
  });
  const options = buildPluginHostSessionRuntimeOptions(buildPluginSessionBindingInput({
    credentials: { token: 'token', encryption: null },
    backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    directory: home, startedBy: partition.startedBy,
    resume: partition.resume,
    initialAccess: await consumeSessionInitialAccessFile(partition.initialAccessFilePath!),
    primaryTeamId: partition.primaryTeamId,
    placementOrigin: partition.placementOrigin,
  }));
  expect(partition.providerArgs).toEqual([]);
  await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(runHostSessionRuntime(options, {
    flavor: 'codex', policyAgentId: 'codex', backendDisplayName: 'Codex', uiLogPrefix: '[test]',
    providerName: 'Codex', waitingForCommandLabel: 'Codex', agentMessageType: 'codex',
    runtimeActivityApplicability: 'not_applicable',
    machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test', homeDir: home, happyHomeDir: home, happyLibDir: home },
    loadTerminalDisplay: async () => () => null,
    formatPromptErrorMessage: String,
  })).rejects.toMatchObject(refusal);
  expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toMatchObject({ initialAccess, primaryTeamId });
  const body = vi.mocked(axios.post).mock.calls[0]?.[1];
  if (placementOrigin) {
    expect(body).toMatchObject({
      ownerMetadata: { t: 'plain', v: { system: { placementOrigin } } },
    });
  } else {
    expect(body).not.toHaveProperty('ownerMetadata.v.system.placementOrigin');
  }
});
