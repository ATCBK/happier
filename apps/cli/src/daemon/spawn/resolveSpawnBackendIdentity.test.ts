import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { encryptStoredSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const {
  readStoredCredentialsMock,
} = vi.hoisted(() => ({
  readStoredCredentialsMock: vi.fn(async (): Promise<StoredCredentials | null> => null),
}));

// Credential storage is an OS boundary; attach identity, HTTP parsing and crypto stay real.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: readStoredCredentialsMock,
}));

import { mapExistingSessionAttachFailureToSpawnError, resolveSpawnBackendIdentity } from './resolveSpawnBackendIdentity';
import { createCustomAcpAdmissionRuntimeFixture } from '../startup/customAcpAdmission.testkit';
import { AgentExecutionTargetV1Schema, CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveDaemonCatalogAgentIdFromBackendTarget, resolveDaemonCliSubcommandFromBackendTarget } from '../backendTargetRouting';
import { resolveBundledPluginIdForBackendTarget } from '../bundledBackendPluginMetadata';
import { BackendTargetRefV2Schema, buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildHappySessionControlArgs } from '../sessionSpawnArgs';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { resolveTrackedSessionCatalogAgentId } from '../sessions/resolveTrackedSessionCatalogAgentId';

let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
const app = Fastify();
let restoreHttp: (() => void) | undefined;
let session = createSessionRecordFixture({ id: 'session', encryptionMode: 'plain', metadata: '{}' });
let acceptedToken: string | undefined;
beforeAll(async () => {
  app.get('/v2/sessions/:sessionId', async (request, reply) => {
    if (acceptedToken && request.headers.authorization !== `Bearer ${acceptedToken}`) return reply.code(401).send({ error: 'unauthorized' });
    const { sessionId } = request.params as { sessionId: string };
    return { session: { ...session, id: sessionId } };
  });
  app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: session.encryptionMode ?? 'plain' }));
  await app.ready();
  restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(resolveServerHttpBaseUrl()).origin });
  runtime = await createCustomAcpAdmissionRuntimeFixture();
});
afterAll(async () => {
  try { await runtime?.dispose(); } finally { restoreHttp?.(); await app.close(); }
});
beforeEach(() => {
  readStoredCredentialsMock.mockReset();
  readStoredCredentialsMock.mockResolvedValue(null);
  acceptedToken = undefined;
  session = createSessionRecordFixture({ id: 'session', encryptionMode: 'plain', metadata: '{}' });
});

function setPlainMetadata(metadata: Readonly<Record<string, unknown>>) {
  session = createSessionRecordFixture({ id: 'session', encryptionMode: 'plain', metadata: JSON.stringify(metadata) });
}

function linkedMetadata(remoteSessionId: string, vendorSessionId = remoteSessionId) {
  return { directSessionV1: { v: 1, providerId: 'antigravity', machineId: 'machine-1', remoteSessionId,
    source: { kind: 'antigravityCliPrint', brainDir: '/tmp/antigravity-brain' } }, antigravitySessionId: vendorSessionId };
}

function createLegacyCredentials(token: string, seed: number): Credentials & { encryption: { type: 'legacy'; secret: Uint8Array } } {
  return {
    token,
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(seed),
    },
  };
}

describe('resolveSpawnBackendIdentity credential precedence', () => {
  it('preserves a safe Session-detail diagnostic in the typed spawn failure', () => {
    expect(mapExistingSessionAttachFailureToSpawnError({
      ok: false,
      reason: 'fetchFailed',
      diagnostic: {
        errorClass: 'Error',
        errorCode: 'session_detail_invalid_response',
        httpStatus: null,
        stackFrames: [],
      },
    })).toMatchObject({
      type: 'error',
      errorCode: 'UNEXPECTED',
      errorDetail: {
        kind: 'launch_error',
        code: 'session_detail_invalid_response',
      },
    });
  });

  it('prefers caller-provided credentials over persisted credentials for existing-session attach context', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 1);
    const stalePersistedCredentials = createLegacyCredentials('stale-token', 9);
    readStoredCredentialsMock.mockResolvedValueOnce(stalePersistedCredentials);
    acceptedToken = liveCredentials.token;
    session = createSessionRecordFixture({ id: 'sess-live', encryptionMode: 'e2ee',
      metadata: encryptStoredSessionPayload({ mode: 'e2ee',
        ctx: { encryptionKey: liveCredentials.encryption.secret, encryptionVariant: 'legacy' },
        payload: { flavor: 'codex', codexSessionId: 'live-native-session' } }) });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-live',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({ ok: true, effectiveResume: 'live-native-session',
      sessionAttachPayload: { v: 2, encryptionMode: 'e2ee', encryptionVariant: 'legacy',
        encryptionKeyBase64: encodeBase64(liveCredentials.encryption.secret) } });
  });

  it('accepts canonical V2 backend targets directly on the spawn path', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 11);
    const creationTarget = resolveSessionCreationAgentTarget(AgentExecutionTargetV1Schema.parse({
      kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    }));
    expect(creationTarget).toEqual({
      agentId: 'codex', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-live-v2',
      resume: '',
      agentTarget: undefined,
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      catalogAgentId: 'codex',
    });
  });

  it('falls back to persisted credentials only when caller credentials are null', async () => {
    const persistedCredentials: StoredCredentials = {
      token: 'persisted-token',
      encryption: null,
    };
    readStoredCredentialsMock.mockResolvedValueOnce(persistedCredentials);
    acceptedToken = persistedCredentials.token;
    setPlainMetadata({ flavor: 'codex', codexSessionId: 'persisted-native-session' });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-persisted',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: null,
    });

    expect(result).toMatchObject({ ok: true, effectiveResume: 'persisted-native-session',
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' } });
  });

  it('requires canonical attach identity instead of reviving a local handoff overlay backend identity', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 4);
    setPlainMetadata({ handoffSourceSessionId: 'sess-handoff-direct' });
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff-source',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown Agent or backend target',
      },
    });
  });

  it('rejects a resume whose canonical attach context has no backend target', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 16);
    setPlainMetadata({});

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff-source',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown Agent or backend target',
      },
    });
  });

  it('does not infer an external Agent identity from retired handoff metadata', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 14);
    setPlainMetadata({ path: '/tmp/external', nativeSessionId: 'acme-session-1' });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-external',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown Agent or backend target',
      },
    });
  });

  it('fails closed when an external Agent is unavailable rather than falling back to Claude', async () => {
    expect(resolveSessionCreationAgentTarget(AgentExecutionTargetV1Schema.parse({
      kind: 'agent', identity: { pluginId: 'com.acme.agent', localId: 'acme-agent' },
    }))).toBeNull();
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'acme-agent', sourceKind: 'built_in' },
      credentials: createLegacyCredentials('live-token', 15),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown backend target',
      },
    });
  });

  it('refuses an existing-session spawn when linked resume identity is unavailable', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 12);
    setPlainMetadata(linkedMetadata('verified-linked-id', 'stale-vendor-id'));
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-linked-stale',
      resume: 'caller-supplied-stale-id',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' },
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
  });

  it('uses the verified linked vendor resume id instead of a caller-supplied resume id', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 13);
    setPlainMetadata(linkedMetadata('verified-linked-id'));

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-linked-current',
      resume: 'caller-supplied-stale-id',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'antigravity', sourceKind: 'built_in' },
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveResume: 'verified-linked-id',
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'antigravity',
        sourceKind: 'built_in',
      },
    });
  });

  it('preserves configured ACP backend targets as canonical V2 targets', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 5);
    setPlainMetadata({ flavor: 'acp:review-bot' });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-configured',
      resume: '',
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'custom-acp',
        sourceKind: 'built_in',
      },
      effectiveAgentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
      catalogAgentId: 'custom-acp',
    });
  });

  it('preserves the qualified definition selection through real admission and launch catalog routing', async () => {
    expect(resolveSessionCreationAgentTarget({
      kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
    })).toBeNull();
    const agentTarget = AgentExecutionTargetV1Schema.parse({
      kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'review-bot',
    });
    const creationTarget = resolveSessionCreationAgentTarget(agentTarget);
    expect(creationTarget).not.toBeNull();
    if (!creationTarget) throw new Error('Expected authored Session/Bot selection');
    expect(buildBackendTargetKeyV2(BackendTargetRefV2Schema.parse(creationTarget.backendTarget)))
      .toBe(buildBackendTargetKeyV2(agentTarget));
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '', resume: '', agentTarget, backendTarget: creationTarget.backendTarget, credentials: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected qualified Custom ACP admission');
    expect(AgentExecutionTargetV1Schema.parse(result.effectiveAgentTarget)).toEqual(agentTarget);
    expect(BackendTargetRefV2Schema.parse(result.effectiveBackendTargetV2)).toMatchObject({
      backendId: 'custom-acp', configuredBackendId: agentTarget.definitionId, sourceKind: 'built_in',
    });
    expect(buildBackendTargetKeyV2(result.effectiveBackendTargetV2)).toBe(buildBackendTargetKeyV2(agentTarget));
    expect(result.catalogAgentId).toBe('custom-acp');
    expect(resolveDaemonCatalogAgentIdFromBackendTarget(result.effectiveBackendTargetV2)).toBe(result.catalogAgentId);
    expect(resolveDaemonCliSubcommandFromBackendTarget(result.effectiveBackendTargetV2)).toBe('custom-acp');
    expect(resolveBundledPluginIdForBackendTarget(result.effectiveBackendTargetV2)).toBe(agentTarget.identity.pluginId);
    expect(buildHappySessionControlArgs({ backendTarget: result.effectiveBackendTargetV2 })).toEqual([]);
    expect(resolveTrackedSessionCatalogAgentId({
      spawnOptions: { directory: '/tmp/custom-acp-admission', backendTarget: result.effectiveBackendTargetV2 },
    })).toBe(result.catalogAgentId);
  });

  it('canonicalizes configured ACP targets that still carry the legacy customAcp family marker', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 8);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcp',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      } as never,
      credentials: liveCredentials,
    });

    expect(result).toMatchObject({
      ok: true,
      effectiveBackendTargetV2: {
        kind: 'backend',
        backendId: 'custom-acp',
        sourceKind: 'built_in',
      },
      effectiveAgentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
      catalogAgentId: 'custom-acp',
    });
  });

  it('fails closed when a fresh spawn explicitly provides customAcp as a built-in backend target', async () => {
    const liveCredentials = createLegacyCredentials('live-token', 6);

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'customAcp', sourceKind: 'built_in' },
      credentials: liveCredentials,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        type: 'error',
        errorCode: 'INVALID_REQUEST',
        errorMessage: 'Unknown Agent or backend target',
      },
    });
  });
});

describe('resolveSpawnBackendIdentity opaque Agent resume id', () => {
  /** The Agent minted these bytes; the daemon hands them straight back. */
  const OPAQUE_RESUME_ID = ' provider\nsession ';

  it('carries the exact resume bytes into the resolved backend identity', async () => {
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: '',
      resume: OPAQUE_RESUME_ID,
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: null,
    });

    expect(result).toMatchObject({ ok: true, effectiveResume: OPAQUE_RESUME_ID });
  });

  it('does not use resume bytes as a retired local metadata lookup key', async () => {
    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-handoff',
      resume: OPAQUE_RESUME_ID,
      agentTarget: undefined,
      backendTarget: undefined,
      credentials: null,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it('adopts an attached Session vendor resume id without renormalizing its bytes', async () => {
    readStoredCredentialsMock.mockResolvedValue({ token: 'plain-token', encryption: null });
    setPlainMetadata({ flavor: 'codex', codexSessionId: OPAQUE_RESUME_ID });

    const result = await resolveSpawnBackendIdentity({
      existingSessionId: 'sess-attached',
      resume: '',
      agentTarget: undefined,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      credentials: null,
    });

    expect(result).toMatchObject({ ok: true, effectiveResume: OPAQUE_RESUME_ID });
  });
});
