import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getSessionTranscript } from './getSessionTranscript';
import { getSessionEvents } from './getSessionEvents';

describe('Session semantic readers content mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['plain', 'e2ee'] as const)('rejects mismatched %s transcript and event rows before semantic extraction', async (encryptionMode) => {
    const sessionId = 'c1234567890123456789012345';
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (path === `/v2/sessions/${sessionId}`) {
        return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode }) } };
      }
      if (path === `/v1/sessions/${sessionId}/messages`) {
        return { status: 200, data: { messages: [{ id: 'message-1', seq: 1, createdAt: 1, content: encryptionMode === 'plain'
          ? { t: 'encrypted', c: 'unopenable' }
          : { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not disclose' } } },
        }], hasMore: false } };
      }
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    const params = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } },
      idOrPrefix: sessionId,
    };
    await expect(getSessionTranscript(params)).rejects.toMatchObject({ code: 'session_content_mode_mismatch' });
    await expect(getSessionEvents(params)).rejects.toMatchObject({ code: 'session_content_mode_mismatch' });
  });
});
