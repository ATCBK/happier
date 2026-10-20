import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { openTerminalProvisioningV3Response } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

describe('auth approve request pairing context', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
  ] as const;

  let localHomeDir = '';
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(async () => {
    envScope = createEnvKeyScope(envKeys);
    localHomeDir = await createTempDir('happier-cli-auth-approve-');
  });

  afterEach(async () => {
    envScope.restore();
    vi.resetModules();
    vi.unstubAllGlobals();
    await removeTempDir(localHomeDir);
  });

  function buildRequestEnvelope() {
    const terminalKeypair = tweetnacl.box.keyPair();
    const pairingSecret = new Uint8Array(32).fill(11);
    const createdAtMs = Date.now() - 60_000;
    const expiresAtMs = Date.now() + 3_600_000;
    const envelope = {
      publicKey: Buffer.from(terminalKeypair.publicKey).toString('base64'),
      publicKeyB64Url: Buffer.from(terminalKeypair.publicKey).toString('base64url'),
      claimSecret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
      pairing: {
        secretB64Url: Buffer.from(pairingSecret).toString('base64url'),
        createdAtMs,
        expiresAtMs,
      },
      supportsTokenOnly: true,
    };
    return { terminalKeypair, pairingSecret, createdAtMs, expiresAtMs, envelope };
  }

  it.each([false, true])('approves a pairing-bound v3 response with unattended Team access explicitly selected: %s', async (authorizeUnattendedTeamAccess) => {
    const { terminalKeypair, pairingSecret, createdAtMs, expiresAtMs, envelope } = buildRequestEnvelope();
    const envelopePath = join(localHomeDir, 'remote-auth-request.json');
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');

    const postedBodies: Array<Record<string, unknown>> = [];
    const app = fastify({ logger: false });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.post('/v1/auth/response', async (req, reply) => {
      postedBodies.push(req.body as Record<string, unknown>);
      return reply.send({ success: true });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'local-token' });

      const { handleAuthApprove } = await import('./approve');
      const stdout = captureStdoutJsonOutput();
      await handleAuthApprove([
        '--json',
        '--public-key',
        envelope.publicKey,
        '--request-json-file',
        envelopePath,
        ...(authorizeUnattendedTeamAccess ? ['--authorize-unattended-team-access'] : []),
      ]);
      expect(stdout.json<{ success: boolean }>()).toEqual({ success: true });

      expect(postedBodies).toHaveLength(1);
      const body = postedBodies[0] ?? {};
      expect(body.publicKey).toBe(envelope.publicKey);
      expect(body.responseKind).toBe('tokenOnly');
      if (authorizeUnattendedTeamAccess) {
        expect(body.authorizeUnattendedTeamAccess).toBe(true);
      } else {
        expect(body).not.toHaveProperty('authorizeUnattendedTeamAccess');
      }
      expect(typeof body.response).toBe('string');
      const opened = openTerminalProvisioningV3Response({
        payload: new Uint8Array(Buffer.from(String(body.response), 'base64')),
        recipientSecretKeyOrSeed: terminalKeypair.secretKey,
        terminalEphemeralPublicKey: terminalKeypair.publicKey,
        pairingSecret,
        createdAtMs,
        expiresAtMs,
        nowMs: Date.now(),
      });
      expect(opened).toEqual({ type: 'tokenOnly' });
    } finally {
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('rejects a request envelope whose public key does not match --public-key', async () => {
    const { envelope } = buildRequestEnvelope();
    const envelopePath = join(localHomeDir, 'remote-auth-request.json');
    await writeFile(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');

    const otherKeypair = tweetnacl.box.keyPair();
    const app = fastify({ logger: false });
    const postedBodies: Array<Record<string, unknown>> = [];
    app.post('/v1/auth/response', async (req, reply) => {
      postedBodies.push(req.body as Record<string, unknown>);
      return reply.send({ success: true });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'local-token' });

      const { handleAuthApprove } = await import('./approve');
      await expect(
        handleAuthApprove([
          '--json',
          '--public-key',
          Buffer.from(otherKeypair.publicKey).toString('base64'),
          '--request-json-file',
          envelopePath,
        ]),
      ).rejects.toThrow('process.exit:2');
      expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('public key'))).toBe(true);
      expect(postedBodies).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);

  it('guides the operator to supply the request envelope when the approval lacks a pairing context', async () => {
    const app = fastify({ logger: false });
    const postedBodies: Array<Record<string, unknown>> = [];
    app.post('/v1/auth/response', async (req, reply) => {
      postedBodies.push(req.body as Record<string, unknown>);
      return reply.send({ success: true });
    });
    await app.ready();
    const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'http://happier-auth.test' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined): never => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      envScope.patch({
        HAPPIER_HOME_DIR: localHomeDir,
        HAPPIER_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_PUBLIC_SERVER_URL: 'http://happier-auth.test',
        HAPPIER_WEBAPP_URL: 'http://webapp.test',
      });
      vi.resetModules();
      const { writeCredentialsTokenOnly } = await import('@/persistence');
      await writeCredentialsTokenOnly({ token: 'local-token' });

      const terminalKeypair = tweetnacl.box.keyPair();
      const { handleAuthApprove } = await import('./approve');
      await expect(
        handleAuthApprove([
          '--json',
          '--public-key',
          Buffer.from(terminalKeypair.publicKey).toString('base64'),
        ]),
      ).rejects.toThrow('process.exit:1');
      expect(
        errorSpy.mock.calls.some((args) => String(args[0]).includes('--request-json-file')),
      ).toBe(true);
      expect(postedBodies).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      restoreAxios();
      await app.close().catch(() => {});
    }
  }, 20_000);
});
