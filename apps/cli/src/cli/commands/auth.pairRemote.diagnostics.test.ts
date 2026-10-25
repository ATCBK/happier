import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { reloadConfiguration } from '@/configuration';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

describe('auth pair-remote diagnostic secret custody', () => {
  it.each([true, false])('redacts post-pair diagnostics (valid JSON=%s)', async validJson => {
    await withTempDir('happier-auth-pair-diagnostics-', async home => {
      const diagnosticBearer = 'private-remote-diagnostic-bearer';
      const diagnosticKey = 'private-remote-recovery-key';
      const homeIdentity = 'srv_terminal_pairing_home';
      const descriptor = { v: 1 as const, homeServerIdentityId: homeIdentity,
        canonicalServerUrl: 'https://happier-auth.test', revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://happier-auth.test' }] };
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL', 'HAPPIER_LOG_LEVEL']);
      const app = fastify({ logger: false });
      app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
      app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
      app.post('/v1/auth/response', async () => ({ success: true }));
      await app.ready();
      const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://happier-auth.test' });
      const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
        features: {}, homeConnectionDescriptor: descriptor, capabilities: { serverIdentity: { serverIdentityId: homeIdentity },
          accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: 2,
            currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1' } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      try {
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://happier-auth.test',
          HAPPIER_PUBLIC_SERVER_URL: 'https://happier-auth.test', HAPPIER_WEBAPP_URL: 'http://webapp.test', HAPPIER_LOG_LEVEL: 'silent' });
        reloadConfiguration();
        const { adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
        const { profile } = await adoptServerProfileHomeConnectionDescriptor({ descriptor, observation: 'exact', use: true });
        const { writeCredentialsTokenOnlyForServerId } = await import('@/persistence');
        await writeCredentialsTokenOnlyForServerId(profile.id, { token: 'local-pairing-bearer' });
        const { handleAuthPairRemote } = await import('./auth/pairRemote');
        const publicKey = Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64');
        const output = captureStdoutJsonOutput<unknown>();
        try {
          await handleAuthPairRemote(['--home', profile.id, '--ssh', 'user@host', '--json'], {
            // SSH and HTTP are process/network boundaries; approval and the
            // enrollment recipe run their real internal logic.
            createEnrollmentExecutor: () => ({
              runHappierJson: async () => { throw new Error('Unexpected split enrollment'); },
              runHappierText: async (args, options) => {
                if (args[0] === 'doctor') return { status: 0,
                  stdout: validJson ? JSON.stringify({ ok: true, token: diagnosticBearer, recoverySecret: diagnosticKey }) : `Authorization: Bearer ${diagnosticBearer}`,
                  stderr: `recovery_secret=${diagnosticKey}` };
                const now = Date.now();
                const stdout = [JSON.stringify({ kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
                  publicKey, homeServerIdentityId: homeIdentity,
                  pairing: { secretB64Url: Buffer.alloc(32, 7).toString('base64url'), createdAtMs: now, expiresAtMs: now + 60_000 },
                  supportsTokenOnly: true, pairingRequirement: 'v3' }),
                  JSON.stringify({ kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
                    homeServerIdentityId: homeIdentity, machineId: 'remote-machine', encryptionType: 'tokenOnly',
                    pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile' })].join('\n') + '\n';
                options?.onStdoutChunk?.(stdout);
                return { status: 0, stdout, stderr: '' };
              },
            }),
          });
          expect(output.json()).toMatchObject({ success: true, machineId: 'remote-machine', postCheck: { exitCode: 0 } });
          const text = output.chunks.join('');
          expect(text).not.toContain(diagnosticBearer);
          expect(text).not.toContain(diagnosticKey);
          expect(text).not.toContain('local-pairing-bearer');
        } finally { output.restore(); }
      } finally { features.mockRestore(); restoreAxios(); env.restore(); reloadConfiguration(); await app.close(); }
    });
  });
});
