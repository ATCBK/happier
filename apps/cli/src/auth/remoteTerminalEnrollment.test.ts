import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
// Collect the real CLI graph before individual test lifetimes; reload its
// environment-bound configuration per case after setting the isolated Home.
import './remoteTerminalEnrollment';

const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_managed_home', canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }] };
const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' });
const correlation = { homeId: descriptor.homeServerIdentityId, managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1, controller: { machineId: 'controller', installationId: 'installation' }, resource: { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } } };

describe('managed remote terminal enrollment', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  afterEach(() => { env.restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('rejects a different admitted Home before any authentication request', async () => {
    const fetchBoundary = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchBoundary);
    const post = vi.spyOn(axios, 'post');
    const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
    await expect(runRemoteTerminalEnrollment({ target, managedEnrollment: { ...correlation, homeId: 'srv_other_home' }, timeoutMs: 5_000, onPairingRequest: () => undefined })).rejects.toThrow(/selected Home/);
    expect(fetchBoundary).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('recovers a post-claim feature 503 within the relay lifetime, then preserves cancellation before bearer persistence', async () => {
    await withTempDir('happier-managed-enrollment-cancel-', async (homeDir) => {
      env.patch({ HAPPIER_HOME_DIR: homeDir });
      const controller = new AbortController();
      let response = '';
      const expiresAt = Date.now() + 240_000;
      let observedExpiry: number | undefined;
      let authenticatedObservations = 0;
      let claims = 0;
      // HTTP is the only mocked boundary: pairing, crypto, Home verification and credential IO stay real.
      const httpResult = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
      vi.spyOn(axios, 'post').mockImplementation(async (url) => {
        if (String(url).endsWith('/claim')) {
          claims++;
          return httpResult({ state: 'authorized', serverIdentityId: descriptor.homeServerIdentityId, token: 'full-account-bearer', response });
        }
        return httpResult({ state: 'requested', expiresAt });
      });
      vi.spyOn(axios, 'get').mockResolvedValue(httpResult({ status: 'authorized' }));
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
        if (String(url).endsWith('/authenticated')) {
          authenticatedObservations++;
          if (authenticatedObservations === 1) return new Response('{}', { status: 503 });
          controller.abort();
        }
        return new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } }, homeConnectionDescriptor: descriptor }), { status: 200 });
      }));
      const { runRemoteTerminalEnrollment } = await import('./remoteTerminalEnrollment');
      await expect(runRemoteTerminalEnrollment({ target, managedEnrollment: correlation, timeoutMs: 5_000, signal: controller.signal,
        onPairingRequest: (request) => {
          observedExpiry = request.pairing.expiresAtMs;
          response = Buffer.from(sealTerminalProvisioningV3TokenOnlyPayload({
            terminalEphemeralPublicKey: Buffer.from(request.publicKey, 'base64'),
            pairingSecret: Buffer.from(request.pairing.secretB64Url, 'base64url'),
            createdAtMs: request.pairing.createdAtMs, expiresAtMs: request.pairing.expiresAtMs,
            randomBytes: (length) => new Uint8Array(randomBytes(length)),
          })).toString('base64');
        },
      })).rejects.toThrow(/cancel|abort/i);
      expect(observedExpiry).toBe(expiresAt);
      expect(authenticatedObservations).toBe(2);
      expect(claims).toBe(1);
      expect((await readdir(homeDir, { recursive: true })).some((path) => /(?:^|[\\/])access\.key$/u.test(path))).toBe(false);
    });
  });
});
