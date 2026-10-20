import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { encodeAutomationTemplateCiphertextForAccount } from './encodeAutomationTemplateCiphertextForAccount';

let accountMode: 'plain' | 'e2ee' = 'plain';

describe('encodeAutomationTemplateCiphertextForAccount', () => {
  beforeEach(async () => {
    invalidateAccountEncryptionModeCache();
    accountMode = 'plain';
    // Replace only the external HTTP port; focused request authority stays real.
    setRuntimeFetch(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
      if (path === '/v1/account/encryption') return Response.json({ mode: accountMode, updatedAt: 1 });
      throw new Error(`Unexpected automation HTTP: ${path}`);
    });
    await upsertAndActivateServer({ serverUrl: 'https://automation-template.test', scope: 'device' });
  });
  afterEach(resetRuntimeFetch);

  it('returns plaintext envelope for plain accounts without calling encryptRaw', async () => {
    const encryptRaw = vi.fn(async () => 'ciphertext-base64');

    const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
      credentials: { token: 't' },
      template: { directory: '/tmp/project', prompt: 'Hi', transcriptStorage: 'direct', existingSessionId: 'session-1' },
      encryptRaw,
    });

    const envelope = JSON.parse(templateCiphertext);
    expect(envelope.kind).toBe('happier_automation_template_plain_v1');
    expect(envelope.payload).toEqual(expect.objectContaining({ directory: '/tmp/project', prompt: 'Hi', transcriptStorage: 'direct', existingSessionId: 'session-1' }));
    expect(encryptRaw).not.toHaveBeenCalled();
  });

  it('returns encrypted envelope for e2ee accounts and calls encryptRaw', async () => {
    const encryptRaw = vi.fn(async () => 'ciphertext-base64');
    accountMode = 'e2ee';

    const templateCiphertext = await encodeAutomationTemplateCiphertextForAccount({
      credentials: { token: 't' },
      template: { directory: '/tmp/project', prompt: 'Hi', existingSessionId: 'session-1' },
      encryptRaw,
    });

    const envelope = JSON.parse(templateCiphertext);
    expect(envelope.kind).toBe('happier_automation_template_encrypted_v1');
    expect(envelope.payloadCiphertext).toBe('ciphertext-base64');
    expect(encryptRaw).toHaveBeenCalled();
  });
});
