import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateSchema } from '@happier-dev/session-core/state';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
  CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
  CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
  CurrentSessionPresentationBindResultV1Schema,
  CurrentSessionPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions/presentation/currentSessionPresentationV1';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { parsePlainSessionAgentState } from '../../../../ui/sources/sync/engine/sessions/parsePlainSessionPayload';
import { SessionEncryption } from '../../../../ui/sources/sync/encryption/sessionEncryption';
import { SecretBoxEncryption } from '../../../../ui/sources/sync/encryption/encryptor';
import { EncryptionCache } from '../../../../ui/sources/sync/encryption/encryptionCache';
import { applyCurrentSessionPresentationCommand } from '../../../../ui/sources/components/sessions/presentation/applyCurrentSessionPresentationCommand';
import { createCurrentSessionPresentationService } from './currentSessionPresentationService';
import { registerCurrentSessionUiBinding } from './currentSessionUiBindings';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

const boundary = vi.hoisted(() => ({ io: vi.fn(), fetch: vi.fn(), patch: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: boundary.io }));
vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: () => async () => ({ status: 'ready' as const }),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat: boundary.fetch,
  patchSessionMetadataEnvelopeTuple: boundary.patch,
}));

describe('current-session presentation publication composition', () => {
  const clients = new Set<ApiSessionClient>();
  const controllers = new Set<AbortController>();
  beforeEach(() => {
    boundary.io.mockReset().mockImplementation(() => createApiSessionSocketStub({ connected: true }));
    boundary.fetch.mockReset();
    boundary.patch.mockReset();
  });
  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...clients].map((client) => client.close()));
    clients.clear();
    controllers.clear();
  });

  it('carries a real bound apply through owner publication, both UI readers and a matching ACK', async () => {
    const session = createPlainSessionFixture({ id: 'presentation-composed', metadataLayoutVersion: 1 });
    let stored = {
      ...session,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: { t: 'plain' as const, v: { v: 1 as const } },
      agentState: null as string | null,
      dataEncryptionKey: null,
    };
    boundary.fetch.mockImplementation(async () => stored);
    // Only HTTP persistence is replaced. The API client, tuple serializer,
    // presentation registrations, UI hydration and ACK dispatcher remain real.
    boundary.patch.mockImplementation(async ({ patch: input }: Parameters<
      typeof import('@/session/transport/http/sessionsHttp').patchSessionMetadataEnvelopeTuple
    >[0]) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode !== 'owner' || patch.ownerMetadata.t !== 'plain') throw new Error('Expected the plain owner tuple');
      stored = {
        ...stored,
        metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: patch.sharedMetadata.expectedVersion + 1,
        ownerMetadata: patch.ownerMetadata,
        agentState: patch.agentState.ciphertext,
        agentStateVersion: patch.agentState.expectedVersion + 1,
      };
      return SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: stored.metadataVersion }, agentState: { version: stored.agentStateVersion } });
    });
    const client = createTestApiSessionClient(ApiSessionClient, 'owner-token', session, {
      metadataAuthority: { kind: 'owner', credentials: { token: 'owner-token', encryption: null } },
      getAccountEncryptionCurrentness: async () => createAccountEncryptionCurrentnessFixture(),
    });
    clients.add(client);
    const controller = new AbortController();
    controllers.add(controller);
    const presentation = createCurrentSessionPresentationService({ session: client, signal: controller.signal, isCurrent: () => true });
    registerCurrentSessionUiBinding({
      sessionId: session.id,
      service: {
        interactions: { request: async () => { throw new Error('This presentation recipe does not request an interaction'); } },
        presentation,
      },
      signal: controller.signal,
      isCurrent: () => true,
    });
    const deps = createCliActionDeps({ token: 'owner-token', sessionId: session.id, mode: 'plain', ctx: null });
    const apply = (operationId: string) => deps.currentSessionPresentationApply!({
      input: { intent: { kind: 'viewer.open', source: 'computer' } },
      context: { surface: 'agent', defaultSessionId: session.id, actionRequestId: operationId },
    });
    expect(ActionExecuteFailureSchema.parse(await apply('unbound-agent-call'))).toMatchObject({
      ok: false,
      errorCode: 'current_session_presentation_not_current',
      details: {
        stage: 'before_publication', reason: 'client_not_bound', hostNonce: expect.any(String), revision: 0,
      },
    });
    const origin = { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.CURRENT_SESSION_PRESENTATION_ORIGIN,
      sessionId: session.id, accountId: 'owner-account', connectionId: 'viewer-socket' } as const;
    const call = (method: string, params: unknown) => client.rpcHandlerManager.handleRequest({
      method: `${session.id}:${method}`, params, authorization: origin,
    });
    const bound = CurrentSessionPresentationBindResultV1Schema.parse(await call(
      CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD, { clientId: 'viewer-client', focused: true, draftRevision: 0 },
    ));
    expect(bound.status).toBe('bound');
    if (bound.status !== 'bound') throw new Error('Viewer did not bind');
    expect(parsePlainSessionAgentState(stored.agentState)).toHaveProperty(CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY);

    const pending = apply('agent-computer-open');
    await vi.waitFor(() => expect(JSON.parse(stored.agentState ?? '{}')[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]?.command)
      .toMatchObject({ id: 'agent-computer-open', kind: 'presentation.apply', clientId: 'viewer-client', intent: { kind: 'viewer.open', source: 'computer' } }));
    const hydrated = parsePlainSessionAgentState(stored.agentState);
    const state = CurrentSessionPresentationStateV1Schema.parse(hydrated[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]);
    const { [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: omittedPresentation, ...withoutPresentation } = hydrated;
    expect(omittedPresentation).toBeDefined();
    expect(CurrentSessionPresentationStateV1Schema.safeParse(
      AgentStateSchema.parse(withoutPresentation)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    ).success).toBe(false);
    // The encrypted client reads the exact same producer state after real
    // encryption/decryption, through its canonical AgentState hydration path.
    const key = new Uint8Array(32).fill(7);
    const encryptedReader = new SessionEncryption(session.id, new SecretBoxEncryption(key), new EncryptionCache());
    const encrypted = await encryptedReader.decryptAgentState(stored.agentStateVersion,
      encodeBase64(encrypt(key, 'legacy', JSON.parse(stored.agentState!))));
    expect(encrypted[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]).toEqual(state);
    expect(AgentStateSchema.safeParse({ ...hydrated, [CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]: { ...state, revision: -1 } }).success)
      .toBe(false);
    const appliedIntents: unknown[] = [];
    expect(applyCurrentSessionPresentationCommand({
      state, hostNonce: bound.hostNonce, clientId: 'another-client', isCurrentSession: true,
      notify: () => {}, composer: null,
      presentation: { apply: (intent) => { appliedIntents.push(intent); return { status: 'applied' }; } },
    })).toBeNull();
    expect(appliedIntents).toEqual([]);
    const application = applyCurrentSessionPresentationCommand({
      state, hostNonce: bound.hostNonce, clientId: 'viewer-client', isCurrentSession: true,
      notify: () => {}, composer: null,
      presentation: { apply: (intent) => { appliedIntents.push(intent); return { status: 'applied' }; } },
    });
    expect(appliedIntents).toEqual([{ kind: 'viewer.open', source: 'computer' }]);
    expect(application?.ack).toBeDefined();
    expect(await call(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, application!.ack)).toEqual({ status: 'accepted' });
    expect(await pending).toEqual({ status: 'applied', revision: `${bound.hostNonce}:${state.revision}` });
    expect(CurrentSessionPresentationStateV1Schema.parse(
      parsePlainSessionAgentState(stored.agentState)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    ).command).toBeUndefined();

    const uiPending = call(CURRENT_SESSION_PRESENTATION_APPLY_RPC_METHOD, { intent: { kind: 'viewer.open', source: 'computer' } });
    await vi.waitFor(() => expect(JSON.parse(stored.agentState ?? '{}')[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]?.command?.kind)
      .toBe('presentation.apply'));
    const uiState = CurrentSessionPresentationStateV1Schema.parse(
      parsePlainSessionAgentState(stored.agentState)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    );
    const uiApplication = applyCurrentSessionPresentationCommand({
      state: uiState, hostNonce: bound.hostNonce, clientId: 'viewer-client', isCurrentSession: true,
      notify: () => {}, composer: null, presentation: { apply: () => ({ status: 'applied' }) },
    });
    expect(await call(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, uiApplication!.ack)).toEqual({ status: 'accepted' });
    expect(await uiPending).toEqual({ status: 'applied', revision: `${bound.hostNonce}:${uiState.revision}` });

    const notCurrent = apply('agent-no-longer-current');
    await vi.waitFor(() => expect(JSON.parse(stored.agentState ?? '{}')[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY]?.command?.id)
      .toBe('agent-no-longer-current'));
    const rejectedState = CurrentSessionPresentationStateV1Schema.parse(
      parsePlainSessionAgentState(stored.agentState)[CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY],
    );
    const rejection = applyCurrentSessionPresentationCommand({
      state: rejectedState, hostNonce: bound.hostNonce, clientId: 'viewer-client', isCurrentSession: false,
      notify: () => {}, composer: null,
    });
    expect(await call(CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD, rejection!.ack)).toEqual({ status: 'accepted' });
    expect(ActionExecuteFailureSchema.parse(await notCurrent)).toMatchObject({
      ok: false, errorCode: 'current_session_presentation_not_current',
      details: {
        stage: 'client_acknowledgement', reason: 'client_not_current', hostNonce: bound.hostNonce,
        revision: rejectedState.revision, clientId: 'viewer-client', commandId: 'agent-no-longer-current',
      },
    });
  });
});
