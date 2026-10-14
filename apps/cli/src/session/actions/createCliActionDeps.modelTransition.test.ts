import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, getActionSpec, V2SessionRecordSchema } from '@happier-dev/protocol';
import { SessionModelTransitionResultV1Schema } from '@happier-dev/protocol/sessions/control/modelTransitionV1';
import { createCliActionDeps } from './createCliActionDeps';

const boundary = vi.hoisted(() => ({ get: vi.fn(), callSessionRpc: vi.fn() }));
// Only HTTP and the runner RPC transport are replaced. Action admission, Session
// lookup, unarm service and both result projections execute their real logic.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: boundary.get } };
});
vi.mock('@/session/transport/rpc/sessionRpc', () => ({ callSessionRpc: boundary.callSessionRpc }));

const sessionId = 'c123456789012345678901234';
const activeSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'A' };
const session = V2SessionRecordSchema.parse({
  id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
  encryptionMode: 'plain', metadataVersion: 1, metadataLayoutVersion: 0,
  dataEncryptionKey: null, share: null, agentState: null, agentStateVersion: 1,
  metadata: JSON.stringify({ flavor: 'codex', machineId: 'machine-1' }),
});

function executor() {
  return createActionExecutor(createCliActionDeps({
    credentials: { token: 'account-token', encryption: null }, token: 'account-token',
    serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', sessionId, mode: 'plain', ctx: null,
  }));
}

describe('CLI model transition Actions through the real dependency', () => {
  beforeEach(() => {
    boundary.get.mockReset();
    boundary.callSessionRpc.mockReset();
    boundary.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('returns the validated unarmed result after the runner cancels an armed switch', async () => {
    const output = SessionModelTransitionResultV1Schema.parse({
      ok: true, status: 'already_active', activeSelection,
    });
    let armed = true;
    boundary.callSessionRpc.mockImplementation(async (request: Readonly<{ method: string; request: unknown }>) => {
      expect(request.method).toBe(`${sessionId}:session.model.transition`);
      expect(request.request).toEqual({ v: 1, unarm: true });
      armed = false;
      return output;
    });
    const result = await executor().execute('session.model.unarm', { sessionId }, { surface: 'cli' });
    expect(armed).toBe(false);
    expect(result).toEqual({ ok: true, result: output });
    if (!result.ok) throw new Error(result.error);
    expect(getActionSpec('session.model.unarm').outputSchema?.parse(result.result)).toEqual(output);
  });

  it('preserves the runner refusal rather than reporting a projection exception', async () => {
    const output = SessionModelTransitionResultV1Schema.parse({
      ok: false, status: 'owner_unavailable', activeSelection: null, requestedSelection: activeSelection,
      reason: 'runner unavailable',
    });
    boundary.callSessionRpc.mockResolvedValue(output);
    expect(await executor().execute('session.model.unarm', { sessionId }, { surface: 'cli' }))
      .toEqual({ ok: true, result: output });
  });
});
