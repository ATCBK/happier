import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  projectSessionSharedMetadataV1,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { resolveTsxImportHookSpecifier } from '../../src/testkit/process/tsxImportHook';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2, patchSessionMetadataEnvelopeTupleV1 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: observed request retirement recovery', () => {
  let server: StartedServer | null = null;
  afterEach(async () => { await server?.stop(); server = null; });

  it('replays a private keyless retirement across two runtime processes and preserves newer background state', async () => {
    const testDir = run.testDir(`request-settlement-${randomUUID()}`);
    const extraEnv = { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '0' };
    server = await startServerLight({ testDir, dbProvider: 'sqlite', extraEnv });
    const baseUrl = server.baseUrl;
    const auth = await createTestAuth(baseUrl);
    const requestId = 'foreground-request';
    const request = { tool: 'Write', arguments: { path: '/workspace/private-settlement-marker' }, createdAt: Date.now(), kind: 'permission' };
    const initialState = { requests: { [requestId]: request, background: { ...request, createdAt: request.createdAt + 1 } } };
    const metadata = { path: '/workspace', host: 'test-host' };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Unsupported owner metadata fixture');
    const ownerEnvelope = createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata);
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata, agentState: initialState });
    const created = await fetchJson<{ session: { id: string } }>(`${baseUrl}/v1/sessions`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json',
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      body: JSON.stringify({ tag: randomUUID(), encryptionMode: 'plain', metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: JSON.stringify(sharedMetadata) }, ownerMetadata: ownerEnvelope,
        agentState: JSON.stringify(initialState), dataEncryptionKey: null }),
    });
    expect(created.status).toBe(200);
    const sessionId = created.data.session.id;
    const snapshot = await fetchSessionV2(baseUrl, auth.token, sessionId);
    const homeDir = join(testDir, 'runtime-home');
    await mkdir(homeDir, { recursive: true });
    const runtimeSession = {
      id: sessionId, seq: snapshot.seq, encryptionMode: 'plain', metadata, metadataLayoutVersion: 1,
      ownerMetadata: owner.ownerMetadata, ownerMetadataEnvelope: ownerEnvelope,
      metadataVersion: snapshot.metadataVersion, agentState: initialState, agentStateVersion: snapshot.agentStateVersion,
    };
    const launchRuntime = async (phase: 'admit' | 'recover') => {
      const inputPath = join(testDir, `${phase}.json`);
      await writeFile(inputPath, JSON.stringify({ phase, token: auth.token, session: runtimeSession, requestId }), { mode: 0o600 });
      const hook = resolveTsxImportHookSpecifier();
      if (!hook) throw new Error('Missing canonical tsx import hook');
      await runLoggedCommand({
        command: process.execPath, args: ['--import', hook, join(repoRootDir(), 'packages/tests/fixtures/request-settlement-runtime.ts'), inputPath],
        cwd: repoRootDir(), env: { ...process.env, HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: baseUrl,
          TSX_TSCONFIG_PATH: join(repoRootDir(), 'apps/cli/tsconfig.json') },
        stdoutPath: join(testDir, `${phase}.stdout.log`), stderrPath: join(testDir, `${phase}.stderr.log`),
      });
    };
    await server.stop(); server = null;
    await launchRuntime('admit');
    const files = (await readdir(homeDir, { recursive: true })).filter(file => file.endsWith(`session-${sessionId}.json`));
    expect(files).toHaveLength(1);
    const admitted = await readFile(join(homeDir, files[0]), 'utf8');
    expect(JSON.parse(admitted)).toMatchObject({
      mutations: expect.arrayContaining([
        expect.objectContaining({
          kind: 'agent_state_request_settlement',
          payload: expect.objectContaining({ content: expect.objectContaining({ t: 'device_local_v1' }) }),
        }),
      ]),
    });
    expect(admitted).not.toContain('private-settlement-marker');
    server = await startServerLight({ testDir, dbProvider: 'sqlite', extraEnv, preserveExistingDataDir: true,
      __portAllocator: async () => Number(new URL(baseUrl).port) });
    const observer = createUserScopedSocketCollector(baseUrl, auth.token, { declareCurrentAccountStoredContentCompatibility: true });
    observer.connect();
    try {
      await waitFor(() => observer.isConnected(), { timeoutMs: 20_000 });
      const newerState = { ...initialState, requests: { ...initialState.requests, newer: { ...request, createdAt: request.createdAt + 2 } } };
      await patchSessionMetadataEnvelopeTupleV1({ baseUrl, token: auth.token, sessionId, patch: {
        mode: 'owner', metadataLayoutVersion: 1, expectedOwnerMetadata: ownerEnvelope,
        sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: newerState })),
          expectedVersion: snapshot.metadataVersion },
        ownerMetadata: ownerEnvelope,
        agentState: { ciphertext: JSON.stringify(newerState), expectedVersion: snapshot.agentStateVersion },
        activitySummaryV1: { pendingPermissionRequestCount: 3, pendingUserActionRequestCount: 0,
          pendingRequestNewestCreatedAt: newerState.requests.newer.createdAt },
      } });
      // Reconstruct from the older snapshot to exercise the real metadata tuple CAS rebase.
      await launchRuntime('recover');
      const settled = await fetchSessionV2(baseUrl, auth.token, sessionId);
      expect(settled).toMatchObject({ pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 0 });
      const state = JSON.parse(String(settled.agentState));
      expect(Object.keys(state.requests).sort()).toEqual(['background', 'newer']);
      expect(state.completedRequests[requestId].status).toBe('canceled');
      await waitFor(() => observer.getEvents().some(event => event.kind === 'update'
        && event.payload.body?.pendingPermissionRequestCount === 2), { timeoutMs: 20_000 });
    } finally { observer.close(); }
  });
});
