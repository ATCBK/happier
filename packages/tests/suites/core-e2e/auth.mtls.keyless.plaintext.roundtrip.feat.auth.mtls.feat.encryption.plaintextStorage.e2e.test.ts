import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { seedCliTokenOnlyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createMachineRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const currentContentHeaders = buildAccountStoredContentCompatibilityHttpHeadersV1(
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
);

type Machine = {
  id: string;
  metadata: string;
  metadataVersion: number;
  daemonState: string | null;
  daemonStateVersion: number;
  dataEncryptionKey: string | null;
};

function readPlain(value: string): Record<string, unknown> {
  const decoded = decodePlainMachineStoredContent(value);
  expect(decoded).toEqual(expect.any(Object));
  return decoded as Record<string, unknown>;
}


describe('core e2e: keyless mTLS auth roundtrip (plaintext)', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    await server?.stop();
    server = null;
  });

  it('keeps plaintext sessions and machine RPC usable across token-only keyless logins', async () => {
    const testDir = run.testDir('auth-mtls-keyless-plaintext-roundtrip');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: '',

        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: 'CN=Example Root CA',
      },
    });

    const auth = await createTestAuthMtls(server.baseUrl, {
      email: 'alice@example.com',
      issuer: 'CN=Example Root CA',
    });

    const mode = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      headers: { Authorization: `Bearer ${auth.token}`, ...currentContentHeaders },
      timeoutMs: 15_000,
    });
    expect(mode.status).toBe(200);
    expect(mode.data?.mode).toBe('plain');

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...currentContentHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-mtls-plain',
        metadata: JSON.stringify({ v: 1, flavor: 'claude', tag: 'e2e-mtls-plain' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');
    expect(create.data?.session?.encryptionMode).toBe('plain');

    const localId = 'm-mtls-plain-1';
    const commit = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...currentContentHeaders,
        'Content-Type': 'application/json',
        'Idempotency-Key': localId,
      },
      body: JSON.stringify({
        localId,
        content: {
          t: 'plain',
          v: { role: 'user', content: { type: 'text', text: 'hello via mtls' } },
        },
      }),
      timeoutMs: 15_000,
    });
    expect(commit.status).toBe(200);
    expect(commit.data?.didWrite).toBe(true);

    const messages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}`, ...currentContentHeaders },
      timeoutMs: 15_000,
    });
    expect(messages.status).toBe(200);
    const first = messages.data?.messages?.[0];
    expect(first?.content?.t).toBe('plain');
    expect(first?.content?.v?.content?.text).toBe('hello via mtls');

    const secondAuth = await createTestAuthMtls(server.baseUrl, {
      email: 'alice@example.com', issuer: 'CN=Example Root CA',
    });
    const daemonHome = join(testDir, 'daemon-home');
    const secondHome = join(testDir, 'second-client-home');
    const seeded = await seedCliTokenOnlyAuthForServer({
      cliHome: daemonHome, serverUrl: server.baseUrl, token: auth.token,
    });
    const secondSeed = await seedCliTokenOnlyAuthForServer({
      cliHome: secondHome, serverUrl: server.baseUrl, token: secondAuth.token,
    });
    // A keyless login must never manufacture or require local encryption material.
    for (const [home, seed, token] of [[daemonHome, seeded, auth.token], [secondHome, secondSeed, secondAuth.token]] as const) {
      for (const path of [join(home, 'access.key'), join(home, 'servers', seed.serverId, 'access.key')]) {
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ token });
      }
    }
    const claudeConfigDir = join(testDir, 'claude');
    const projectId = 'keyless-project';
    const remoteSessionId = 'keyless-session';
    await mkdir(join(claudeConfigDir, 'projects', projectId), { recursive: true });
    await writeFile(join(claudeConfigDir, 'projects', projectId, `${remoteSessionId}.jsonl`), `${JSON.stringify({
      type: 'user', uuid: 'keyless-user-1', cwd: testDir, message: { content: 'keyless direct session' },
    })}\n`);
    const daemonEnv = {
      ...process.env,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
    };
    daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHome, startupTimeoutMs: 90_000, env: daemonEnv });
    const secondClient = createUserScopedSocketCollector(server.baseUrl, secondAuth.token, {
      declareCurrentAccountStoredContentCompatibility: true,
    });
    secondClient.connect();
    try {
      await waitFor(() => secondClient.isConnected(), { context: 'second keyless client connected' });
      const fetchMachine = async (): Promise<Machine> => {
        const response = await fetchJson<{ machine: Machine }>(`${server!.baseUrl}/v1/machines/${seeded.machineId}`, {
          headers: { Authorization: `Bearer ${secondAuth.token}`, ...currentContentHeaders }, timeoutMs: 15_000,
        });
        expect(response.status).toBe(200);
        return response.data.machine;
      };
      let machine = await fetchMachine();
      await waitFor(async () => {
        machine = await fetchMachine();
        return machine.daemonState !== null && readPlain(machine.daemonState).status === 'running';
      }, { context: 'keyless daemon publishes running state' });
      expect(machine.dataEncryptionKey).toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
      const metadata = readPlain(machine.metadata);
      expect(metadata).toEqual(expect.objectContaining({ host: expect.any(String) }));
      const rpc = createMachineRpcClient(secondClient, { mode: 'plain' });
      const call = async (method: string, payload: unknown): Promise<unknown> =>
        unwrapDataKeyRpcResult(await rpc.call(`${seeded.machineId}:${method}`, payload), 'keyless machine RPC');
      let candidates: unknown;
      await waitFor(async () => {
        candidates = await call(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST, {
          machineId: seeded.machineId, providerId: 'claude',
          source: { kind: 'claudeConfig', configDir: claudeConfigDir, projectId }, limit: 20,
        });
        return typeof candidates === 'object' && candidates !== null && 'candidates' in candidates;
      }, { timeoutMs: 30_000, context: 'actual keyless daemon external session candidates' });
      expect(candidates).toEqual(expect.objectContaining({
        ok: true, candidates: expect.arrayContaining([expect.objectContaining({ remoteSessionId })]),
      }));
      expect(await call(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET, {})).toEqual(expect.objectContaining({
        protocolVersion: 3, sameMachineHandoff: true,
      }));
      const update = await secondClient.emitWithAck<{ result: string }>('machine-update-metadata', {
        machineId: seeded.machineId, expectedVersion: machine.metadataVersion,
        metadata: encodePlainMachineStoredContent({ ...metadata, displayName: 'Keyless renamed machine' }),
      });
      expect(update.result).toBe('success');
      const renamed = await fetchMachine();
      expect(renamed.metadataVersion).toBeGreaterThan(machine.metadataVersion);
      expect(readPlain(renamed.metadata).displayName).toBe('Keyless renamed machine');
      await daemon.stop();
      daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHome, startupTimeoutMs: 90_000, env: daemonEnv });
      let restarted = await fetchMachine();
      await waitFor(async () => {
        restarted = await fetchMachine();
        return restarted.daemonState !== null && readPlain(restarted.daemonState).status === 'running';
      }, { context: 'restarted keyless daemon publishes running state' });
      expect(readPlain(restarted.metadata).displayName).toBe('Keyless renamed machine');
      expect(restarted.daemonStateVersion).toBeGreaterThan(machine.daemonStateVersion);
      expect(await call(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET, {})).toEqual(expect.objectContaining({ protocolVersion: 3 }));
      expect(JSON.parse(await readFile(join(daemonHome, 'access.key'), 'utf8'))).toEqual({ token: auth.token });
    } finally {
      secondClient.close();
    }

  }, 240_000);
});

