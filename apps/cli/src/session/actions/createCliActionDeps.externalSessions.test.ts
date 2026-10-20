import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import type { StoredCredentials } from '@/persistence';

const http = vi.hoisted(() => ({ get: vi.fn() }));
const persistedCredentials = vi.hoisted(() => ({ current: null as StoredCredentials | null }));
// Session ownership and link admission stay real beneath the authenticated HTTP boundary.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: http.get } };
});
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => persistedCredentials.current,
}));

const configurationBoundary = vi.hoisted(() => ({
  activeServerDir: '/tmp/happier-external-session-action-unset',
}));

vi.mock('@/configuration', async importOriginal => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return { ...actual, configuration: { ...actual.configuration,
    get activeServerDir() { return configurationBoundary.activeServerDir; },
  } };
});

import { createCliActionDeps } from './createCliActionDeps';

const roots: string[] = [];

beforeEach(() => { http.get.mockReset(); persistedCredentials.current = null; });

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe('createCliActionDeps External Session bindings', () => {
  it('routes hook management through the daemon-composed External Sessions owner', async () => {
    const hookManagementAction = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true as const,
        rows: [],
        nextCursor: null,
        diagnostics: [],
      },
    }));
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      externalSessionPluginAdmissionOwner: { hookManagementAction },
    });

    await expect(deps.pluginSessionHookManagementAction?.({
      actionId: 'plugins.sessionHooks.status.get',
      input: { intent: 'passive_inventory' },
    })).resolves.toEqual({
      ok: true,
      rows: [],
      nextCursor: null,
      diagnostics: [],
    });
    expect(hookManagementAction).toHaveBeenCalledWith(
      'plugins.sessionHooks.status.get',
      { intent: 'passive_inventory' },
      { surface: 'action' },
    );
  });

  it('passes the daemon-composed private materialize Start into the plugin action consumer', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-plugin-materialize-action-'));
    roots.push(activeServerDir);
    configurationBoundary.activeServerDir = activeServerDir;
    const credentials = {
      token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`,
      encryption: null,
    };
    persistedCredentials.current = credentials;
    const fields = buildSessionMetadataEnvelopeFields({ credentials,
      accountEncryptionMode: 'plain', storedContentMode: 'plain', agentState: null,
      metadata: { externalSessionV1: { v: 1, machineId: 'machine-1', agentId: 'codex',
        remoteSessionId: 'remote-1', source: { kind: 'codexHome', home: '/private/home' }, linkedAtMs: 1 } },
    });
    const session = createCurrentSessionProjectionRecordFixture({ id: 'session-1', encryptionMode: 'plain', share: null,
      metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext,
      ownerMetadata: fields.ownerMetadata,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    });
    const sessionResponse = V2SessionByIdResponseSchema.parse({ session });
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    http.get.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v2/sessions/session-1') return { status: 200, data: sessionResponse };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      throw new Error(`unexpected_http:${path}`);
    });
    const materializeStart = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'internal_error' as const, message: 'fixture' },
    }));
    const deps = createCliActionDeps({
      token: credentials.token,
      credentials,
      sessionId: 'plugin-global',
      mode: 'plain',
      ctx: null,
      externalSessionPluginAdmissionOwner: { materializeStart },
    });

    const result = await deps.externalSessionAction?.({
      actionId: 'sessions.external.materialize.start',
      input: {
        request: {
          v: 1,
          idempotencyKey: 'caller-key',
          sessionId: 'session-1',
          plan: 'materialize',
          targetStorageMode: 'external-linked',
          targetRuntimeMode: null,
        },
      },
      pluginId: 'author.example',
    });

    expect(result).toEqual({
      ok: true,
      result: {
        ok: false,
        error: { code: 'internal_error', message: 'fixture' },
      },
    });
    expect(materializeStart).toHaveBeenCalledWith({
      sessionId: 'session-1',
      durableIdempotencyKey: expect.stringMatching(
        /^plugin-operation:v1:[0-9a-f]{64}$/,
      ),
      authorIntent: {
        v: 1,
        surface: 'plugin',
        kind: 'materialize',
        sessionId: 'session-1',
        targetStorageMode: 'external-linked',
      },
    });
  });
});
