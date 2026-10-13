import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createVoiceDiagnosticsController } from './controller';
import { createVoiceDiagnosticStore } from './store';
import { createDiagnosticsControllerWithRemovalFailure } from './controller.testkit';

const enabledSettings = Object.freeze({
  v: 1 as const,
  enabled: true,
  consentVersion: 1 as const,
  captureSttInput: true,
  captureTtsOutput: false,
  maxAgeMs: 86_400_000,
  maxFiles: 20,
  maxBytes: 104_857_600,
  maxDurationMs: 300_000,
});

describe('voice diagnostics controller capture authorization', () => {
  it('fails closed when a capture omits its request-local authorization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      const controller = createVoiceDiagnosticsController({ happyHomeDir: home });
      await controller.configure({
        v: 1,
        enabled: true,
        consentVersion: 1,
        captureSttInput: true,
        captureTtsOutput: false,
        maxAgeMs: 86_400_000,
        maxFiles: 20,
        maxBytes: 104_857_600,
        maxDurationMs: 300_000,
      });

      await expect(controller.capture({
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
      })).resolves.toBeNull();
      expect((await controller.status()).artifacts).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('revokes an active session authorization before later terminal capture attempts persist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      const controller = createVoiceDiagnosticsController({ happyHomeDir: home });
      await controller.configure({
        v: 1,
        enabled: true,
        consentVersion: 1,
        captureSttInput: true,
        captureTtsOutput: false,
        maxAgeMs: 86_400_000,
        maxFiles: 20,
        maxBytes: 104_857_600,
        maxDurationMs: 300_000,
      });
      const authorizationId = '6a42516d-20ea-4c70-91d5-b0dbaf693637';
      await controller.revokeCaptureAuthorization(authorizationId);

      await expect(controller.capture({
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId: 'attempt', authorizationId,
      })).resolves.toBeNull();
      expect((await controller.status()).artifacts).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps speech capture non-fatal while latching a retryable cleanup failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      const { controller, recoverRemoval } = await createDiagnosticsControllerWithRemovalFailure({ happyHomeDir: home });
      await controller.configure(enabledSettings);
      await expect(controller.capture({
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      })).resolves.toBeNull();
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
        },
      });

      recoverRemoval();
      await controller.deleteAll();
      await expect(controller.status()).resolves.toMatchObject({
        health: { captureFailure: false, cleanup: { status: 'healthy', ownedEntryCount: 0 } },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps an operational retention failure latched until a real cleanup succeeds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      let now = 10_000;
      let denyRemoval = false;
      const controller = createVoiceDiagnosticsController({
        happyHomeDir: home,
        createStore: (policy) => createVoiceDiagnosticStore({
          happyHomeDir: home,
          policy,
          now: () => now,
          removeFile: async (path) => {
            if (denyRemoval) {
              throw Object.assign(new Error('simulated_retention_remove_failure'), { code: 'EPERM' });
            }
            await unlink(path);
          },
        }),
      });
      const policy = { ...enabledSettings, maxAgeMs: 300_000 };
      await controller.configure(policy);
      const capture = (attemptId: string) => controller.capture({
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId,
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      });

      await expect(capture('first')).resolves.not.toBeNull();
      now += 300_001;
      denyRemoval = true;
      await expect(capture('second')).resolves.toBeNull();
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [{ direction: 'stt_input', byteLength: 7 }],
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 2 },
        },
      });

      await controller.configure(policy);
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 2 },
        },
      });

      denyRemoval = false;
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 2 },
        },
      });

      await controller.configure(policy);
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: {
          captureFailure: false,
          cleanup: { status: 'healthy', ownedEntryCount: 0 },
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps a failed explicit deletion latched until delete-all itself succeeds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      let denyRemoval = false;
      const controller = createVoiceDiagnosticsController({
        happyHomeDir: home,
        createStore: (policy) => createVoiceDiagnosticStore({
          happyHomeDir: home,
          policy,
          removeFile: async (path) => {
            if (denyRemoval) {
              throw Object.assign(new Error('simulated_delete_remove_failure'), { code: 'EPERM' });
            }
            await unlink(path);
          },
        }),
      });
      await controller.configure(enabledSettings);
      const capture = (attemptId: string) => controller.capture({
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId,
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      });

      await expect(capture('first')).resolves.not.toBeNull();
      denyRemoval = true;
      await expect(controller.deleteAll()).rejects.toThrow('simulated_delete_remove_failure');
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [{ direction: 'stt_input', byteLength: 7 }],
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'delete_failed', ownedEntryCount: 2 },
        },
      });

      denyRemoval = false;
      await controller.configure(enabledSettings);
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [{ direction: 'stt_input', byteLength: 7 }],
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'delete_failed', ownedEntryCount: 2 },
        },
      });
      await expect(capture('second')).resolves.not.toBeNull();
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [
          { direction: 'stt_input', byteLength: 7 },
          { direction: 'stt_input', byteLength: 7 },
        ],
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'delete_failed', ownedEntryCount: 4 },
        },
      });

      await controller.deleteAll();
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: {
          captureFailure: false,
          cleanup: { status: 'healthy', ownedEntryCount: 0 },
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps a disk-headroom capture failure latched until a real capture succeeds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      let diskHasHeadroom = false;
      const controller = createVoiceDiagnosticsController({
        happyHomeDir: home,
        createStore: (policy) => createVoiceDiagnosticStore({
          happyHomeDir: home,
          policy,
          statfs: async () => ({ bavail: diskHasHeadroom ? 1_000_000_000 : 0, bsize: 1 }),
        }),
      });
      await controller.configure(enabledSettings);

      const capture = {
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      } as const;
      await expect(controller.capture(capture)).resolves.toBeNull();
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: { captureFailure: true, cleanup: { status: 'healthy', ownedEntryCount: 0 } },
      });

      await controller.configure(enabledSettings);
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: { captureFailure: true, cleanup: { status: 'healthy', ownedEntryCount: 0 } },
      });

      diskHasHeadroom = true;
      await controller.configure(enabledSettings);
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: { captureFailure: true, cleanup: { status: 'healthy', ownedEntryCount: 0 } },
      });

      await expect(controller.capture(capture)).resolves.not.toBeNull();
      await expect(controller.status()).resolves.toMatchObject({
        health: { captureFailure: false, cleanup: { status: 'healthy', ownedEntryCount: 2 } },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves a capture failure through a later cleanup obligation and its recovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      let diskHasHeadroom = false;
      const controller = createVoiceDiagnosticsController({
        happyHomeDir: home,
        createStore: (policy) => createVoiceDiagnosticStore({
          happyHomeDir: home, policy,
          statfs: async () => ({ bavail: diskHasHeadroom ? 1_000_000_000 : 0, bsize: 1 }),
        }),
      });
      await controller.configure(enabledSettings);
      const capture = {
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      } as const;

      await expect(controller.capture(capture)).resolves.toBeNull();
      await writeFile(join(controller.root, 'deadbeef.wav'), Buffer.from('owned orphan'));
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: true,
          cleanup: { status: 'required', code: 'cleanup_failed', ownedEntryCount: 1 },
        },
      });

      await controller.deleteAll();
      await expect(controller.status()).resolves.toMatchObject({
        health: { captureFailure: true, cleanup: { status: 'healthy', ownedEntryCount: 0 } },
      });

      diskHasHeadroom = true;
      const artifact = await controller.capture(capture);
      expect(artifact).not.toBeNull();
      expect(await readFile(artifact!.audioPath)).toEqual(Buffer.from('private'));
      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [expect.objectContaining({ id: artifact!.id, byteLength: 7 })],
        health: {
          captureFailure: false,
          // A real committed artifact owns its audio AND metadata, unlike the copied store.
          cleanup: { status: 'healthy', ownedEntryCount: 2 },
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves a capture failure through catalog unreadability and recovery in either order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      let diskHasHeadroom = false;
      let catalogReadable = true;
      let successfulReadsBeforeLosingAccess: number | null = null;
      const controller = createVoiceDiagnosticsController({
        happyHomeDir: home,
        createStore: (policy) => createVoiceDiagnosticStore({
          happyHomeDir: home, policy,
          statfs: async () => ({ bavail: diskHasHeadroom ? 1_000_000_000 : 0, bsize: 1 }),
          // The genuine OS read retains its overloads; only access failure is controlled.
          readArtifactFile: (async (...args: Parameters<typeof readFile>) => {
            if (!catalogReadable) throw Object.assign(new Error('simulated_catalog_unreadable'), { code: 'EACCES' });
            const bytes = await readFile(...args);
            if (successfulReadsBeforeLosingAccess !== null) {
              successfulReadsBeforeLosingAccess -= 1;
              if (successfulReadsBeforeLosingAccess === 0) catalogReadable = false;
            }
            return bytes;
          }) as typeof readFile,
        }),
      });
      await controller.configure(enabledSettings);
      const capture = {
        direction: 'stt_input', format: 'webm', bytes: Buffer.from('private'), durationMs: null,
        sessionId: 'session', providerId: 'provider', attemptId: 'attempt',
        authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
      } as const;

      await expect(controller.capture(capture)).resolves.toBeNull();
      await writeFile(join(controller.root, 'deadbeef.json'), '{}');
      catalogReadable = false;
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: true,
          cleanup: { status: 'required', code: 'catalog_unreadable', ownedEntryCount: null },
        },
      });

      catalogReadable = true;
      await controller.configure(enabledSettings);
      await expect(controller.status()).resolves.toMatchObject({
        health: { captureFailure: true, cleanup: { status: 'healthy', ownedEntryCount: 0 } },
      });

      diskHasHeadroom = true;
      // The actual store's post-commit prune and return read both succeed;
      // access is then lost before the controller's separate health inspection.
      successfulReadsBeforeLosingAccess = 2;
      const artifact = await controller.capture(capture);
      expect(artifact).not.toBeNull();
      expect(await readFile(artifact!.audioPath)).toEqual(Buffer.from('private'));
      await expect(controller.status()).resolves.toMatchObject({
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'catalog_unreadable', ownedEntryCount: null },
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps an unreadable owned catalog visible as a cleanup obligation across status reloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-diagnostics-controller-'));
    try {
      const controller = createVoiceDiagnosticsController({
        happyHomeDir: home,
        createStore: (policy) => createVoiceDiagnosticStore({
          happyHomeDir: home, policy,
          // Preserve the native read API, with an actual owned metadata file behind its failure.
          readArtifactFile: (async () => {
            throw Object.assign(new Error('simulated_catalog_unreadable'), { code: 'EACCES' });
          }) as typeof readFile,
          removeFile: async () => {
            throw Object.assign(new Error('simulated_delete_failure'), { code: 'EPERM' });
          },
        }),
      });
      await mkdir(controller.root, { recursive: true });
      await writeFile(join(controller.root, 'deadbeef.json'), '{}');

      await expect(controller.status()).resolves.toMatchObject({
        artifacts: [],
        health: {
          captureFailure: false,
          cleanup: { status: 'required', code: 'catalog_unreadable', ownedEntryCount: null },
        },
      });
      await expect(controller.status()).resolves.toMatchObject({
        health: { cleanup: { status: 'required' } },
      });
      await expect(controller.deleteAll()).rejects.toThrow('simulated_delete_failure');
      await expect(controller.status()).resolves.toMatchObject({
        health: { cleanup: { status: 'required' } },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

});
