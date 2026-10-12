import { describe, expect, it, vi } from 'vitest';
import { SessionInputRequestV1Schema } from '@happier-dev/protocol';
import { createCliActionDeps } from './createCliActionDeps';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// HTTP is the Home boundary; Action composition, input policy and serialization stay real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, ...http } };
});

describe('CLI host Message admission', () => {
  it('admits ordinary CLI input without dropping its target permission defaults', async () => {
    const sessionId = 'cmv3hostadmissionaaaaaaaaa';
    const metadata = JSON.stringify({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 1 });
    http.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (url.includes('/v2/sessions/')) return { status: 200, data: { session: {
        id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata, metadataVersion: 1, agentState: null, agentStateVersion: 0,
        dataEncryptionKey: null, encryptionMode: 'plain',
      } } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    http.post.mockResolvedValue({ status: 200, data: { didWrite: true, terminal: false, suppressed: false } });
    const deps = createCliActionDeps({
      token: 'test-account-token', sessionId,
      credentials: { token: 'test-account-token', encryption: null },
    });
    await expect(deps.sessionSendMessage!({
      sessionId, message: 'Start the panel workflow', callerSurface: 'cli',
      actionCaller: { kind: 'host' }, localId: 'host-input', wait: false,
      context: { surface: 'cli', authority: 'present_user' },
      requestedAction: { v: 1, kind: 'enqueue' },
    })).resolves.toMatchObject({ status: 'accepted', localId: 'host-input' });
    const write = http.post.mock.calls.find(([url]) => String(url).endsWith(`/v2/sessions/${sessionId}/pending`));
    expect(write?.[1]).toMatchObject({ content: { t: 'plain', v: { meta: {
      permissionMode: 'safe-yolo', happierProvenanceV1: { v: 1, kind: 'cli' },
      happierInputRequestV1: { v: 1, producer: 'cli', caller: { kind: 'host' } },
    } } } });
    expect(SessionInputRequestV1Schema.safeParse(write?.[1].content.v.meta.happierInputRequestV1).success).toBe(true);
  });
});
