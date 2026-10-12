import { beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import {
  SessionDiscussionAgentPostResponseV1Schema,
  type SessionDiscussionAgentPostRequestV1,
  type SessionDiscussionAgentPostResponseV1,
} from '@happier-dev/protocol/sessions/discussions/api';

const { axiosRequest, fetchSessionById, resolveFeatureDecision } = vi.hoisted(() => ({
  axiosRequest: vi.fn(),
  resolveFeatureDecision: vi.fn(async (_input?: unknown) => ({
    decision: { state: 'enabled' },
    serverSnapshot: { status: 'ready', features: { features: {}, capabilities: {} } },
  })),
  fetchSessionById: vi.fn(async (_input?: unknown): Promise<{
    id: string;
    encryptionMode: string;
    dataEncryptionKey: null;
    effectiveAccess?: unknown;
  }> => ({
    id: 'session-1',
    encryptionMode: 'e2ee',
    dataEncryptionKey: null,
  })),
}));

vi.mock('axios', () => ({ default: { request: axiosRequest } }));
vi.mock('@/features/featureDecisionService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/featureDecisionService')>()),
  resolveCliFeatureDecisionForServer: resolveFeatureDecision,
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionById,
}));

import { createSessionDiscussionActionDeps } from './sessionDiscussionActionDeps';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';

const capabilities = {
  postMessages: true,
  rename: true,
  archive: true,
  restore: false,
  askAgent: true,
  sendToSession: true,
};

const discussionCrypto = {
  mode: 'e2ee' as const,
  ctx: {
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'legacy' as const,
  },
};

function wireSummary(crypto: SessionStoredContentCryptoContext = discussionCrypto) {
  return {
    id: 'discussion-1',
    sessionId: 'session-1',
    creationLocalId: 'creation-1',
    titleContent: { ...sealSessionStoredContent({
      ...crypto,
      payload: { v: 1, title: 'Title', retiredField: true },
    }), retiredEnvelopeField: true },
    latestMessage: {
      id: 'message-1',
      localId: 'message-1',
      seq: 1,
      authorAccountId: 'account-1',
      accountActor: { v: 1, accountId: 'account-1', profile: null },
      producerV1: null,
      createdAt: 1,
    },
    messageSeq: 1,
    lastReadSeq: 0,
    unreadCount: 1,
    unreadMentionCount: 0,
    recentAuthorAccountIds: ['account-1'],
    archivedAt: null,
    capabilities,
  };
}

function wireMessage(crypto: SessionStoredContentCryptoContext = discussionCrypto) {
  return {
    id: 'message-1',
    discussionId: 'discussion-1',
    localId: 'message-1',
    seq: 1,
    authorAccountId: 'account-1',
    accountActor: { v: 1, accountId: 'account-1', profile: null },
    producerV1: null,
    content: { ...sealSessionStoredContent({
      ...crypto,
      payload: { v: 1, retiredField: true, parts: [{ t: 'text', text: 'Hello', retiredField: true }] },
    }), retiredEnvelopeField: true },
    mentionedAccountIds: [],
    createdAt: 1,
  };
}

function discussionAction(options: Readonly<{
  postAgentMessage?: (
    input: SessionDiscussionAgentPostRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionDiscussionAgentPostResponseV1>;
}> = {}) {
  const deps = createSessionDiscussionActionDeps({
    credentials: {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    },
    serverId: 'server-1',
    serverHttpBaseUrl: 'https://home.example.test',
    ...options,
  });
  return deps.sessionDiscussionAction;
}

it('requires a fixed Home identity and endpoint to be supplied as one pair', () => {
  const credentials = {
    token: 'token-1',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
  };
  expect(() => createSessionDiscussionActionDeps({ credentials, serverId: 'server-1' } as never))
    .toThrow('fixed_action_server_target_incomplete');
  expect(() => createSessionDiscussionActionDeps({ credentials, serverHttpBaseUrl: 'https://home.example.test' } as never))
    .toThrow('fixed_action_server_target_incomplete');
});

describe('createSessionDiscussionActionDeps', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolveFeatureDecision.mockResolvedValue({
      decision: { state: 'enabled' },
      serverSnapshot: { status: 'ready', features: { features: {}, capabilities: {} } },
    });
    fetchSessionById.mockResolvedValue({
      id: 'session-1',
      encryptionMode: 'e2ee',
      dataEncryptionKey: null,
    });
    axiosRequest.mockResolvedValue({
      status: 200,
      data: { discussion: wireSummary(), firstMessage: wireMessage() },
    });
  });

  it('hydrates current Session access through the exact Home feature snapshot', async () => {
    const serverSnapshot = {
      status: 'ready' as const,
      features: { features: {}, capabilities: {} },
    };
    resolveFeatureDecision.mockResolvedValueOnce({
      decision: { state: 'enabled' },
      serverSnapshot,
    });
    axiosRequest.mockResolvedValueOnce({
      status: 200,
      data: { discussions: [], nextCursor: null },
    });

    await discussionAction()!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1', state: 'active' },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);

    expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://home.example.test',
      sessionId: 'session-1',
      serverFeaturesSnapshot: serverSnapshot,
    }));
  });

  it.each([
    ['direct', { kind: 'direct' as const, shareId: 'share-1' }],
    ['Team-only', { kind: 'team' as const, teamId: 'team-1', requiredByTeamPolicy: false }],
    ['Group-only', { kind: 'group' as const, teamId: 'team-1', groupId: 'group-1' }],
  ])('uses the exact-Home snapshot for %s current detail and reaches canonical auth', async (_label, source) => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    const serverSnapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: {
            enabled: true,
            conversations: { enabled: true },
          },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      }),
    };
    // Team/Group-only detail is qualified only through the exact-Home collaboration
    // decision; the canonical fetchSessionById owner derives accessProjectionVersion=1
    // from this same snapshot and never from a second resolver.
    const { resolveSessionDetailAccessProjectionVersion } = await import('@/session/transport/http/sessionsHttp');
    expect(resolveSessionDetailAccessProjectionVersion({ serverFeaturesSnapshot: serverSnapshot })).toBe(1);
    fetchSessionById.mockResolvedValueOnce({
      id: 'session-1',
      encryptionMode: 'plain',
      dataEncryptionKey: null,
      effectiveAccess: { v: 1, level: 'edit', sources: [source] },
    });
    axiosRequest.mockResolvedValueOnce({
      status: 200,
      data: { discussions: [], nextCursor: null },
    });
    const deps = createSessionDiscussionActionDeps({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      serverId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot: async () => serverSnapshot,
    });
    const result = await deps.sessionDiscussionAction!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1', state: 'active' },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);
    expect(result).toMatchObject({ v: 1, serverId: 'server-1', sessionId: 'session-1' });
    // Exact-Home path never probes; the snapshot above is the only qualifier source.
    expect(resolveFeatureDecision).not.toHaveBeenCalled();
    expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://home.example.test',
      sessionId: 'session-1',
      serverFeaturesSnapshot: serverSnapshot,
    }));
    // Canonical auth reaches the Home discussion route.
    expect(axiosRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('https://home.example.test/v2/sessions/session-1/discussions'),
    }));
  });

  it('fails a supported old Home closed without appending a qualifier', async () => {
    const resolveServerFeaturesSnapshot = async () => ({
      status: 'unsupported' as const,
      reason: 'endpoint_missing' as const,
    });
    const { resolveSessionDetailAccessProjectionVersion } = await import('@/session/transport/http/sessionsHttp');
    expect(resolveSessionDetailAccessProjectionVersion({
      serverFeaturesSnapshot: await resolveServerFeaturesSnapshot(),
    })).toBeUndefined();
    const deps = createSessionDiscussionActionDeps({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      serverId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot,
    });
    await expect(deps.sessionDiscussionAction!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1' },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never)).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action',
    });
    expect(resolveFeatureDecision).not.toHaveBeenCalled();
    // No positive exact-Home decision, so no qualified detail is ever requested.
    const qualified = fetchSessionById.mock.calls.some((call) => {
      const arg = call[0] as { serverFeaturesSnapshot?: { status?: string } } | undefined;
      return arg?.serverFeaturesSnapshot?.status === 'ready';
    });
    expect(qualified).toBe(false);
  });

  it('places the E2EE creation equality tag on the canonical create request body', async () => {
    const result = await discussionAction()!({
      actionId: 'session.discussion.create',
      input: {
        sessionId: 'session-1',
        creationLocalId: 'creation-1',
        title: 'Title',
        firstMessage: {
          localId: 'message-1',
          content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
          mentionedAccountIds: [],
        },
      },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);

    expect(result).toMatchObject({ v: 1, serverId: 'server-1', sessionId: 'session-1' });
    const body = JSON.parse(axiosRequest.mock.calls[0]![0].data as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      creationLocalId: 'creation-1',
      creationEqualityEvidenceV1: {
        kind: 'e2eeTag',
        tag: expect.any(String),
      },
      firstMessage: {
        localId: 'message-1',
        requestEqualityEvidenceV1: {
          kind: 'e2eeTag',
          tag: expect.any(String),
        },
      },
    });
    expect(body.creationLocalId).not.toBe((body.firstMessage as { localId: string }).localId);
    expect(result).toMatchObject({
      discussion: { title: 'Title' },
      firstMessage: { content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] } },
    });
    expect(result).not.toHaveProperty('discussion.titleContent');
    expect(result).not.toHaveProperty('firstMessage.content.t');
  });

  it('derives E2EE equality evidence from the supplied exact Session key with token-only credentials', async () => {
    const key = new Uint8Array(32).fill(23);
    const crypto = { mode: 'e2ee' as const, ctx: { encryptionKey: key, encryptionVariant: 'dataKey' as const } };
    const resolveExactSessionEncryptionMaterial = vi.fn((sessionId: string) =>
      sessionId === 'session-1' ? { mode: 'e2ee' as const, dataEncryptionKey: key } : null);
    axiosRequest.mockResolvedValueOnce({
      status: 200,
      data: { discussion: wireSummary(crypto), firstMessage: wireMessage(crypto) },
    });
    const action = createSessionDiscussionActionDeps({
      credentials: { token: 'token-1', encryption: null },
      serverId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test',
      resolveExactSessionEncryptionMaterial,
    }).sessionDiscussionAction!;

    const result = await action({
      actionId: 'session.discussion.create',
      input: {
        sessionId: 'session-1',
        creationLocalId: 'creation-1',
        title: 'Title',
        firstMessage: {
          localId: 'message-1',
          content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
          mentionedAccountIds: [],
        },
      },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);

    expect(resolveExactSessionEncryptionMaterial).toHaveBeenCalledWith('session-1');
    const body = JSON.parse(axiosRequest.mock.calls[0]![0].data as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      creationEqualityEvidenceV1: { kind: 'e2eeTag', tag: expect.any(String) },
      firstMessage: { requestEqualityEvidenceV1: { kind: 'e2eeTag', tag: expect.any(String) } },
    });
    expect(result).toMatchObject({ discussion: { title: 'Title' } });
  });

  it('uses the same keyless Plain stored-content envelope without client equality evidence', async () => {
    fetchSessionById.mockResolvedValueOnce({
      id: 'session-1',
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    axiosRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        discussion: {
          ...wireSummary(),
          titleContent: { t: 'plain', v: { v: 1, title: 'Title', retiredField: true }, retiredEnvelopeField: true },
        },
        firstMessage: {
          ...wireMessage(),
          content: { t: 'plain', v: { v: 1, retiredField: true, parts: [{ t: 'text', text: 'Hello', retiredField: true }] }, retiredEnvelopeField: true },
        },
      },
    });

    const action = createSessionDiscussionActionDeps({
      credentials: { token: 'token-1', encryption: null },
      serverId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test',
      resolveExactSessionEncryptionMaterial: () => ({ mode: 'plain' }),
    }).sessionDiscussionAction!;
    const result = await action({
      actionId: 'session.discussion.create',
      input: {
        sessionId: 'session-1',
        creationLocalId: 'creation-1',
        title: 'Title',
        firstMessage: {
          localId: 'message-1',
          content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
          mentionedAccountIds: [],
        },
      },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);

    const body = JSON.parse(axiosRequest.mock.calls[0]![0].data as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      creationLocalId: 'creation-1',
      titleContent: { t: 'plain', v: { v: 1, title: 'Title' } },
      firstMessage: {
        localId: 'message-1',
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Hello' }] } },
      },
    });
    expect(body).not.toHaveProperty('creationEqualityEvidenceV1');
    expect(body.firstMessage).not.toHaveProperty('requestEqualityEvidenceV1');
    expect(result).toMatchObject({ discussion: { title: 'Title' }, firstMessage: {
      content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
    } });
    expect(result).not.toHaveProperty('firstMessage.content.retiredField');
    expect(result).not.toHaveProperty('firstMessage.content.parts.0.retiredField');
  });

  it('rejects exact Session material that disagrees with the persisted mode before a discussion write', async () => {
    const action = createSessionDiscussionActionDeps({
      credentials: { token: 'token-1', encryption: null },
      serverId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test',
      resolveExactSessionEncryptionMaterial: () => ({ mode: 'plain' }),
    }).sessionDiscussionAction!;

    await expect(action({
      actionId: 'session.discussion.create',
      input: {
        sessionId: 'session-1',
        creationLocalId: 'creation-1',
        title: 'Title',
        firstMessage: {
          localId: 'message-1',
          content: { v: 1, parts: [{ t: 'text', text: 'Hello' }] },
        },
      },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never)).resolves.toEqual({
      ok: false,
      errorCode: 'encryption_material_unavailable',
      error: 'encryption_material_unavailable',
    });
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('marks a mismatched stored-content envelope incomplete instead of reinterpreting it', async () => {
    fetchSessionById.mockResolvedValueOnce({
      id: 'session-1',
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    axiosRequest.mockResolvedValueOnce({
      status: 200,
      data: { discussions: [wireSummary()], nextCursor: null },
    });

    const result = await discussionAction()!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1' },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);

    expect(result).toMatchObject({
      incomplete: true,
      discussions: [{ title: null }],
    });
  });

  it('uses the canonical Action binder for route parameters and list query encoding', async () => {
    axiosRequest.mockResolvedValueOnce({
      status: 200,
      data: { discussions: [], nextCursor: null },
    });

    const result = await discussionAction()!({
      actionId: 'session.discussion.list',
      input: {
        sessionId: 'session-1',
        state: 'archived',
        cursor: 'cursor/next?',
        limit: 17,
      },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
    } as never);

    expect(result).toMatchObject({ v: 1, serverId: 'server-1', sessionId: 'session-1' });
    expect(axiosRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://home.example.test/v2/sessions/session-1/discussions?state=archived&cursor=cursor%2Fnext%3F&limit=17',
      method: 'GET',
    }));
    expect(axiosRequest.mock.calls[0]![0]).not.toHaveProperty('params');
    expect(axiosRequest.mock.calls[0]![0]).not.toHaveProperty('data');
  });

  it('signs feature, Session, and final external discussion reads without the daemon bearer', async () => {
    const keyPair = tweetnacl.sign.keyPair();
    const target = { kind: 'session' as const, sessionId: 'session-1' };
    const authorization: ExternalActionExecutionAuthorizationV1 = {
      v: 1,
      token: 'execution-proof',
      binding: {
        serverIdentityId: 'server-1', accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1', actionId: 'session.discussion.list', requestId: 'request-1',
        requestEnvelopeDigest: 'd'.repeat(43), target,
      },
    };
    axiosRequest.mockResolvedValueOnce({ status: 200, data: { discussions: [], nextCursor: null } });
    const deps = createSessionDiscussionActionDeps({
      credentials: {
        token: 'daemon-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      serverId: 'server-1',
      serverIdentityId: 'server-1',
      serverHttpBaseUrl: 'https://home.example.test',
      externalActionMachineRequestPrivateKey: keyPair.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    const context = {
      serverId: 'server-1', surface: 'cli' as const, authority: 'account_automation' as const,
      externalActionCredential: { accountId: 'account-1', principalId: 'principal-1', credentialId: 'credential-1', grant: authorization.binding.grant },
      externalActionExecutionAuthorization: authorization,
      externalActionTarget: target,
    };

    await deps.sessionDiscussionAction!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1', state: 'archived', cursor: 'cursor/next?', limit: 17 },
      context,
    });

    const verify = (headers: Readonly<Record<string, string>>, path: string) => {
      expect(headers.Authorization).toBeUndefined();
      expect(headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('execution-proof');
      expect(headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('session.discussion.list');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'session.discussion.list',
        target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'GET',
        path,
        publicKey: keyPair.publicKey,
        signature: String(headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
      })).toBe(true);
    };
    const featureCalls = resolveFeatureDecision.mock.calls as unknown as Array<[
      { resolveAuthorizationHeaders: (request: { method: 'GET'; path: string }) => Readonly<Record<string, string>> },
    ]>;
    const featureResolver = featureCalls[0]![0].resolveAuthorizationHeaders;
    verify(featureResolver({ method: 'GET', path: '/v1/features' }), '/v1/features');
    const sessionCalls = fetchSessionById.mock.calls as unknown as Array<[
      { resolveAuthorizationHeaders: (request: { method: 'GET'; path: string }) => Readonly<Record<string, string>> },
    ]>;
    const sessionResolver = sessionCalls[0]![0].resolveAuthorizationHeaders;
    verify(sessionResolver({ method: 'GET', path: '/v2/sessions/session-1' }), '/v2/sessions/session-1');
    verify(
      axiosRequest.mock.calls[0]![0].headers,
      '/v2/sessions/session-1/discussions?state=archived&cursor=cursor%2Fnext%3F&limit=17',
    );
  });

  it('reports cancellation before dispatch while an in-flight disconnect remains outcome-unknown', async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(discussionAction()!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1' },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
      signal: abort.signal,
    } as never)).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(axiosRequest).not.toHaveBeenCalled();

    const inFlight = new AbortController();
    axiosRequest.mockImplementationOnce(async () => {
      inFlight.abort();
      throw Object.assign(new Error('connection lost'), { code: 'ERR_CANCELED' });
    });
    await expect(discussionAction()!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1' },
      context: { serverId: 'server-1', surface: 'cli', authority: 'present_user' },
      signal: inFlight.signal,
    } as never)).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
  });

  it('fails an Agent post closed before HTTP while no trusted provenance carrier exists', async () => {
    axiosRequest.mockResolvedValue({
      status: 200,
      data: { message: wireMessage(), messageSeq: 2 },
    });
    const input = {
      sessionId: 'session-1',
      discussionId: 'discussion-1',
      localId: 'message-2',
      content: { v: 1, parts: [{ t: 'text', text: 'Agent result' }] },
      mentionedAccountIds: [],
    } as const;

    const result = await discussionAction()!({
      actionId: 'session.discussion.post',
      input,
      context: {
        serverId: 'server-1',
        surface: 'agent',
        authority: 'account_automation',
        defaultSessionId: 'session-1',
        runtimeRunId: 'run-1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
        },
      },
    } as never);
    expect(result).toEqual({
      ok: false,
      errorCode: 'session_discussion_post_denied',
      error: 'session_discussion_post_denied',
    });
    expect(resolveFeatureDecision).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('uses the trusted Session publisher carrier for an Agent post and never HTTP', async () => {
    const postAgentMessage = vi.fn(async () => SessionDiscussionAgentPostResponseV1Schema.parse({
      ok: true,
      v: 1,
      value: {
        message: {
          ...wireMessage(),
          producerV1: {
            v: 1,
            kind: 'agent',
            sessionId: 'session-1',
            runId: 'run-1',
            toolCallId: 'tool-1',
          },
        },
        messageSeq: 2,
      },
    }));
    const action = discussionAction({ postAgentMessage });
    const signal = new AbortController().signal;

    const result = await action!({
      actionId: 'session.discussion.post',
      input: {
        sessionId: 'session-1',
        discussionId: 'discussion-1',
        localId: 'message-2',
        content: { v: 1, parts: [{ t: 'text', text: 'Agent result' }] },
        mentionedAccountIds: [],
      },
      context: {
        serverId: 'server-1',
        surface: 'agent',
        authority: 'account_automation',
        defaultSessionId: 'session-1',
        runtimeRunId: 'run-1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
        },
      },
      signal,
    } as never);

    expect(result).toMatchObject({
      v: 1,
      sessionId: 'session-1',
      message: {
        producerV1: {
          kind: 'agent',
          sessionId: 'session-1',
          runId: 'run-1',
          toolCallId: 'tool-1',
        },
      },
    });
    expect(postAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      sessionId: 'session-1',
      discussionId: 'discussion-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      request: expect.objectContaining({ localId: 'message-2' }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('rejects an Agent cross-Session target before feature, Session, or HTTP work', async () => {
    const result = await discussionAction()!({
      actionId: 'session.discussion.post',
      input: {
        sessionId: 'session-2',
        discussionId: 'discussion-1',
        content: { v: 1, parts: [{ t: 'text', text: 'No' }] },
      },
      context: {
        serverId: 'server-1',
        surface: 'agent',
        authority: 'account_automation',
        defaultSessionId: 'session-1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
        },
      },
    } as never);

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_discussion_post_denied',
      error: 'session_discussion_post_denied',
    });
    expect(resolveFeatureDecision).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(axiosRequest).not.toHaveBeenCalled();
  });

  it('rejects a mismatched admitted transcript origin before HTTP work', async () => {
    const result = await discussionAction()!({
      actionId: 'session.discussion.list',
      input: { sessionId: 'session-1' },
      context: {
        serverId: 'server-1',
        surface: 'agent',
        authority: 'account_automation',
        defaultSessionId: 'session-1',
        approvalOrigin: {
          kind: 'transcript_tool_call',
          sessionId: 'session-2',
          toolCallId: 'tool-1',
        },
      },
    } as never);

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_discussion_read_denied',
      error: 'session_discussion_read_denied',
    });
    expect(resolveFeatureDecision).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(axiosRequest).not.toHaveBeenCalled();
  });
});
