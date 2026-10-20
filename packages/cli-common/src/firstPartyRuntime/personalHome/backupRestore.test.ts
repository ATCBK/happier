import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as tar from 'tar';

import { createPersonalHomeBackup } from './backup.js';
import { createPersonalHomeArchive, extractVerifiedPersonalHomeArchive, extractVerifiedPersonalHomeArchiveSnapshot, PERSONAL_HOME_BACKUP_QUICK_INSPECTION_MAX_HEADERS, PERSONAL_HOME_BACKUP_QUICK_INSPECTION_MAX_MANIFEST_BYTES, readPersonalHomeArchiveManifestMetadata, verifyPersonalHomeArchive, verifyPersonalHomeArchiveSnapshot, withPrivatePersonalHomeArchiveSnapshot } from './archive.js';
import { resolvePersonalHomeRuntimeLayout } from './layout.js';
import { finalizePersonalHomeRestoreWithLease, hasMeaningfulPersonalHomeData, inspectPersonalHomeRestoreRecovery, recoverPersonalHomeRestoreWithLease, restorePersonalHomeBackup as restorePersonalHomeBackupOwner } from './restore.js';
import { isAllowedPersonalHomeBackupDirectoryPath, parsePersonalHomeBackupManifest } from './manifest.js';
import { preparePersonalHomeSanitizedConfiguration } from './productionAdapters.js';
import { assertStablePersonalHomeSqliteSnapshot, PersonalHomeSqliteSnapshotError } from './sqliteSnapshot.js';
import type { PersonalHomeRestorableConfigurationV1 } from './configuration.js';

const sqliteOk = { checkpoint: async () => ({ busy: 0 }), quickCheck: async () => true, close: async () => undefined } as const;
const prepareConfiguration = async () => ({ rollbackArtifact: '/tmp/test-config-rollback', apply: async () => undefined, rollback: async () => undefined });
const restorePersonalHomeBackup = (params: Parameters<typeof restorePersonalHomeBackupOwner>[0]) =>
  restorePersonalHomeBackupOwner({
    ...params,
    isSchemaSupported: async (schemaVersion) => schemaVersion === '1',
    sqliteMaintenance: params.sqliteMaintenance ?? (async () => sqliteOk),
    runMigrations: async () => undefined,
    verifyStagedIdentity: async () => true,
    inspectConfigurationStorage: params.inspectConfigurationStorage ?? (async () => ({ targetPath: join(params.layout.configDir, 'server.env'), incomingBytes: 0, rollbackBytes: 0 })),
  });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-'));
  const layout = resolvePersonalHomeRuntimeLayout({ homeDir: root, platform: 'linux', mode: 'user' });
  await mkdir(layout.dataDir, { recursive: true });
  await mkdir(join(layout.publicFilesDir, 'nested'), { recursive: true });
  await mkdir(layout.privateFilesDir, { recursive: true });
  await writeFile(layout.databasePath, 'sqlite-fixture');
  await writeFile(layout.masterSecretPath, 'master-secret-fixture');
  await writeFile(join(layout.publicFilesDir, 'nested', 'readme.txt'), 'public');
  await writeFile(join(layout.privateFilesDir, 'secret.txt'), 'private');
  return { root, layout };
}

async function writeStructuralTar(path: string, entries: readonly Readonly<{ path: string; type: 'File' | 'Directory' }>[]): Promise<void> {
  const blocks = entries.map((entry) => {
    const block = Buffer.alloc(512);
    const header = new tar.Header({ path: entry.path, type: entry.type, size: 0, mode: entry.type === 'Directory' ? 0o700 : 0o600, uid: 0, gid: 0, mtime: new Date(0) });
    header.encode(block, 0);
    return block;
  });
  await writeFile(path, Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function recoveryJournalFixture(layout: ReturnType<typeof resolvePersonalHomeRuntimeLayout>, stage: string, id: string) {
  return {
    version: 2,
    phase: 'prepared',
    stage,
    wasRunning: false,
    entries: [
      [layout.databasePath, join(stage, 'database/home.sqlite')],
      [layout.publicFilesDir, join(stage, 'files/public')],
      [layout.privateFilesDir, join(stage, 'files/private')],
      [layout.masterSecretPath, join(stage, 'secrets/handy-master-secret.txt')],
      [layout.derivedDataDir, join(stage, 'derived')],
    ].map(([target, source]) => ({ target, source, rollback: `${target}.restore-rollback-${id}`, hadTarget: false, state: 'untouched' })),
  };
}

describe('Personal Home backup and restore owner', () => {
  it('normalizes manifest entries with locale-independent artifact ordering', () => {
    const hash = createHash('sha256').update('').digest('hex');
    const manifest = parsePersonalHomeBackupManifest({
      format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
      schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: hash,
      databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
      entries: [
        { path: 'files/public/ä.txt', size: 0, sha256: hash },
        { path: 'configuration/home.env.json', size: 0, sha256: hash },
        { path: 'files/public/z.txt', size: 0, sha256: hash },
        { path: 'secrets/handy-master-secret.txt', size: 0, sha256: hash },
        { path: 'database/home.sqlite', size: 0, sha256: hash },
      ],
    });

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      'configuration/home.env.json',
      'database/home.sqlite',
      'files/public/z.txt',
      'files/public/ä.txt',
      'secrets/handy-master-secret.txt',
    ]);
  });

  it.runIf(process.platform !== 'win32').each([false, true])('keeps archive bytes private throughout creation (interrupted: %s)', async (interrupt) => {
    const { root, layout } = await fixture();
    const outputParent = join(root, 'public-output');
    await mkdir(outputParent, { mode: 0o755 });
    await chmod(root, 0o755);
    const previousUmask = process.umask(0o022);
    const observedModes: number[] = [];
    const writtenSizes: number[] = [];
    const originalWrite = fs.write;
    // Observe the real filesystem boundary while tar and the complete backup owner run unchanged.
    const write = vi.spyOn(fs, 'write').mockImplementation((...args: unknown[]) => {
      const fd = args[0];
      const callback = args[args.length - 1];
      if (typeof fd !== 'number' || typeof callback !== 'function') throw new Error('Unexpected filesystem write');
      observedModes.push(fs.fstatSync(fd).mode & 0o777);
      args[args.length - 1] = (...result: unknown[]) => {
        writtenSizes.push(fs.fstatSync(fd).size);
        if (interrupt && writtenSizes.length === 1) callback(Object.assign(new Error('Interrupted archive write'), { code: 'EIO' }), 0);
        else Reflect.apply(callback, undefined, result);
      };
      Reflect.apply(originalWrite, fs, args);
    });
    try {
      const operation = createPersonalHomeBackup({
        layout, outputPath: join(outputParent, 'home.tar'), stagingDir: join(root, 'stage'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0',
        configuration: {}, sqlite: sqliteOk,
      });
      if (interrupt) await expect(operation).rejects.toThrow('Interrupted archive write');
      else await operation;
      expect(writtenSizes.some((size) => size > 0)).toBe(true);
      expect(observedModes.length).toBeGreaterThan(0);
      expect(observedModes.every((mode) => mode === 0o600)).toBe(true);
    } finally {
      write.mockRestore();
      process.umask(previousUmask);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a verified backup with exact cleanup attention when operation-owned staging cannot be removed', async () => {
    const { root, layout } = await fixture();
    const stagingDir = join(root, 'cleanup-failure-stage');
    const outputPath = join(layout.backupsDir, 'cleanup-failure.tar');
    const cleanupStaging = vi.fn(async () => {
      throw Object.assign(new Error('simulated cleanup refusal'), { code: 'EACCES' });
    });
    try {
      const result = await createPersonalHomeBackup({
        layout,
        outputPath,
        stagingDir,
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0',
        configuration: {},
        sqlite: sqliteOk,
        cleanupStaging,
      });

      expect(result.path).toBe(outputPath);
      expect(result.cleanupRequired).toEqual({
        kind: 'backup_staging',
        path: stagingDir,
        error: 'simulated cleanup refusal',
      });
      expect(cleanupStaging).toHaveBeenCalledTimes(2);
      await expect(stat(outputPath)).resolves.toBeTruthy();
      await expect(stat(stagingDir)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('fails closed when target metadata cannot be read', async () => {
    const { root, layout } = await fixture();
    const databaseParent = dirname(layout.databasePath);
    try {
      await chmod(databaseParent, 0o000);
      await expect(hasMeaningfulPersonalHomeData(layout)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(databaseParent, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes new archives with the bounded manifest as the first tar entry', async () => {
    const { root, layout } = await fixture();
    try {
      const archive = await createPersonalHomeBackup({
        layout,
        outputPath: join(layout.backupsDir, 'manifest-first.tar'),
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0',
        configuration: {},
        sqlite: sqliteOk,
      });
      const bytes = await readFile(archive.path);
      expect(new tar.Header(bytes.subarray(0, 512)).path).toBe('manifest.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('short-circuits legacy manifest-late metadata inspection after the manifest body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-manifest-late-'));
    try {
      const archivePath = join(root, 'legacy.tar');
      const emptyHash = createHash('sha256').update('').digest('hex');
      const manifestBytes = Buffer.from(`${JSON.stringify(parsePersonalHomeBackupManifest({
        format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
        schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
        databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
        entries: [
          { path: 'database/home.sqlite', size: 0, sha256: emptyHash },
          { path: 'secrets/handy-master-secret.txt', size: 0, sha256: emptyHash },
          { path: 'configuration/home.env.json', size: 0, sha256: emptyHash },
        ],
      }))}\n`);
      const staging = join(root, 'staging');
      const longPath = `files/public/${'long-segment/'.repeat(24)}payload.txt`;
      await mkdir(dirname(join(staging, longPath)), { recursive: true });
      await writeFile(join(staging, longPath), 'payload');
      await writeFile(join(staging, 'manifest.json'), manifestBytes);
      await tar.create({ cwd: staging, file: archivePath, portable: true, noMtime: true, noDirRecurse: true }, [longPath, 'manifest.json']);
      const archiveBytes = await readFile(archivePath);
      expect(new tar.Header(archiveBytes.subarray(0, 512)).type).toBe('ExtendedHeader');
      archiveBytes.fill(0x61, archiveBytes.length - 1024, archiveBytes.length - 512);
      await writeFile(archivePath, archiveBytes);

      await expect(readPersonalHomeArchiveManifestMetadata(archivePath)).resolves.toMatchObject({
        manifest: { homeServerIdentityId: 'home-identity' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized manifest metadata before allocating its declared body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-manifest-bound-'));
    try {
      const archivePath = join(root, 'oversized.tar');
      const header = Buffer.alloc(512);
      new tar.Header({ path: 'manifest.json', type: 'File', size: PERSONAL_HOME_BACKUP_QUICK_INSPECTION_MAX_MANIFEST_BYTES + 1, mode: 0o600 }).encode(header);
      await writeFile(archivePath, Buffer.concat([header, Buffer.alloc(1024)]));
      await expect(readPersonalHomeArchiveManifestMetadata(archivePath)).rejects.toMatchObject({ code: 'resource_limit' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a declared full-verification manifest that exceeds the available parser memory before buffering it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-full-manifest-declared-bound-'));
    try {
      const archivePath = join(root, 'oversized.tar');
      const header = Buffer.alloc(512);
      new tar.Header({ path: 'manifest.json', type: 'File', size: 1024, mode: 0o600 }).encode(header);
      await writeFile(archivePath, Buffer.concat([header, Buffer.alloc(1024), Buffer.alloc(1024)]));
      await expect(verifyPersonalHomeArchiveSnapshot(archivePath, {
        availableBytes: 4096,
        availableMemoryBytes: 4095,
      })).rejects.toMatchObject({ code: 'resource_limit' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an actual full-verification manifest body that cannot fit the available parser working set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-full-manifest-actual-bound-'));
    try {
      const staging = join(root, 'staging');
      const emptyHash = createHash('sha256').update('').digest('hex');
      const manifest = parsePersonalHomeBackupManifest({
        format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
        schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
        databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
        entries: [
          { path: 'database/home.sqlite', size: 0, sha256: emptyHash },
          { path: 'secrets/handy-master-secret.txt', size: 0, sha256: emptyHash },
          { path: 'configuration/home.env.json', size: 0, sha256: emptyHash },
        ],
      });
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'manifest.json'), manifestBytes);
      for (const entry of manifest.entries) {
        const target = join(staging, entry.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, '');
      }
      const archivePath = join(root, 'actual.tar');
      await tar.create({ cwd: staging, file: archivePath, portable: true, noMtime: true, noDirRecurse: true }, ['manifest.json', ...manifest.entries.map((entry) => entry.path)]);
      await expect(verifyPersonalHomeArchiveSnapshot(archivePath, {
        availableBytes: (await stat(archivePath)).size,
        availableMemoryBytes: manifestBytes.length * 4 - 1,
      })).rejects.toMatchObject({ code: 'resource_limit' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds quick inventory header work without limiting explicit verification of a valid legacy archive', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-quick-entry-bound-'));
    const emptyHash = createHash('sha256').update('').digest('hex');
    const paths = [
      'database/home.sqlite',
      'secrets/handy-master-secret.txt',
      'configuration/home.env.json',
      ...Array.from({ length: PERSONAL_HOME_BACKUP_QUICK_INSPECTION_MAX_HEADERS - 2 }, (_, index) => `files/public/${index}.txt`),
    ];
    const manifest = parsePersonalHomeBackupManifest({
      format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
      schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
      databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
      entries: paths.map((path) => ({ path, size: 0, sha256: emptyHash })),
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const headers = paths.map((path) => {
      const header = Buffer.alloc(512);
      new tar.Header({ path, type: 'File', size: 0, mode: 0o600 }).encode(header);
      return header;
    });
    const manifestHeader = Buffer.alloc(512);
    new tar.Header({ path: 'manifest.json', type: 'File', size: manifestBytes.length, mode: 0o600 }).encode(manifestHeader);
    const archivePath = join(root, 'legacy-large.tar');
    await writeFile(archivePath, Buffer.concat([...headers, manifestHeader, manifestBytes, Buffer.alloc(Math.ceil(manifestBytes.length / 512) * 512 - manifestBytes.length), Buffer.alloc(1024)]));
    try {
      await expect(readPersonalHomeArchiveManifestMetadata(archivePath)).rejects.toMatchObject({ code: 'resource_limit' });
      await expect(verifyPersonalHomeArchiveSnapshot(archivePath, {
        availableBytes: (await stat(archivePath)).size,
        availableEntries: Number.MAX_SAFE_INTEGER,
        availableMemoryBytes: 64 * 1024 * 1024,
      })).resolves.toMatchObject({ entries: { length: paths.length } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates and verifies legacy v1 file-only manifests with more than 4096 entries and safe paths longer than 512 characters', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-large-manifest-'));
    try {
      const stagingDir = join(root, 'staging');
      const longPath = `files/public/${Array.from({ length: 7 }, (_, index) => `${String(index).padStart(2, '0')}-${'a'.repeat(75)}`).join('/')}/file.txt`;
      expect(longPath.length).toBeGreaterThan(512);
      const paths = [
        'database/home.sqlite',
        'secrets/handy-master-secret.txt',
        'configuration/home.env.json',
        longPath,
        ...Array.from({ length: 4093 }, (_, index) => `files/public/many/${String(index).padStart(4, '0')}.txt`),
      ];
      const emptyHash = createHash('sha256').update('').digest('hex');
      for (let offset = 0; offset < paths.length; offset += 200) {
        await Promise.all(paths.slice(offset, offset + 200).map(async (path) => {
          const destination = join(stagingDir, path);
          await mkdir(join(destination, '..'), { recursive: true });
          await writeFile(destination, '');
        }));
      }
      const manifest = parsePersonalHomeBackupManifest({
        format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0.0.0',
        schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
        databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
        entries: paths.map((path) => ({ path, size: 0, sha256: emptyHash })),
      });
      const archive = await createPersonalHomeArchive({ stagingDir, outputPath: join(root, 'large.tar'), manifest });
      const verified = await verifyPersonalHomeArchive(archive.path);
      expect(verified.entries).toHaveLength(paths.length);
      expect(verified.entries.some((entry) => entry.path === longPath)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('archives the fixed database/public/private/secret allowlist and verifies every hash', { timeout: 30_000 }, async () => {
    const { root, layout } = await fixture();
    try {
      const outputPath = join(layout.backupsDir, 'home-1.tar');
      const result = await createPersonalHomeBackup({
        layout,
        outputPath,
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {
          homeServerIdentityId: 'home-identity',
          canonicalServerUrl: 'http://127.0.0.1:43123',
          encryptionStoragePolicy: 'plaintext_only',
          defaultAccountMode: 'plain',
          anonymousSignupPhase: 'loopback-bootstrap-then-disabled',
        },
        sqlite: sqliteOk,
      });
      expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
        'database/home.sqlite',
        'files/private/secret.txt',
        'files/public/nested/readme.txt',
        'secrets/handy-master-secret.txt',
        'configuration/home.env.json',
      ].sort());
      expect(await verifyPersonalHomeArchive(result.path)).toMatchObject({
        format: 'happier-personal-home-backup',
        version: 1,
        homeServerIdentityId: 'home-identity',
      });
      expect(result.archiveBytes).toBe((await stat(result.path)).size);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never replaces a pre-existing backup output', async () => {
    const { root, layout } = await fixture();
    try {
      const outputPath = join(root, 'existing.tar');
      await writeFile(outputPath, 'user-owned-existing-backup');
      await expect(createPersonalHomeBackup({
        layout, outputPath, stagingDir: join(root, 'staging-no-clobber'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0',
        configuration: {
          homeServerIdentityId: 'home-identity', canonicalServerUrl: 'http://127.0.0.1:43123',
          encryptionStoragePolicy: 'plaintext_only', defaultAccountMode: 'plain',
          anonymousSignupPhase: 'loopback-bootstrap-then-disabled',
        },
        sqlite: sqliteOk,
      }))
        .rejects.toMatchObject({ code: 'EEXIST' });
      await expect(readFile(outputPath, 'utf8')).resolves.toBe('user-owned-existing-backup');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses one restrictive private archive snapshot after accepting caller-controlled archive bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-archive-snapshot-'));
    try {
      const archivePath = join(root, 'home.tar');
      await writeFile(archivePath, 'validated-archive-bytes');
      await withPrivatePersonalHomeArchiveSnapshot(archivePath, async (snapshotPath) => {
        await writeFile(archivePath, 'attacker-replacement');
        expect(await readFile(snapshotPath, 'utf8')).toBe('validated-archive-bytes');
        if (process.platform !== 'win32') {
          expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
          expect((await stat(join(snapshotPath, '..'))).mode & 0o777).toBe(0o700);
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks snapshot filesystem capacity before copying caller-controlled archive bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-archive-capacity-'));
    try {
      const archivePath = join(root, 'home.tar');
      await writeFile(archivePath, Buffer.alloc(4096));
      let snapshotUsed = false;
      await expect(withPrivatePersonalHomeArchiveSnapshot(archivePath, async () => {
        snapshotUsed = true;
      }, { availableBytes: 4095, availableEntries: 1 })).rejects.toMatchObject({ code: 'resource_limit' });
      expect(snapshotUsed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects header/manifest size mismatches before creating the extraction destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-header-size-'));
    try {
      const staging = join(root, 'staging');
      const archivePath = join(root, 'hostile.tar');
      const destination = join(root, 'destination');
      const emptyHash = createHash('sha256').update('').digest('hex');
      const manifest = {
        format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
        schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
        databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
        entries: [
          { path: 'database/home.sqlite', size: 0, sha256: emptyHash },
          { path: 'secrets/handy-master-secret.txt', size: 0, sha256: emptyHash },
          { path: 'configuration/home.env.json', size: 0, sha256: emptyHash },
          { path: 'files/public/payload.txt', size: 0, sha256: emptyHash },
        ],
      };
      for (const entry of manifest.entries) {
        const target = join(staging, entry.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.path === 'files/public/payload.txt' ? 'undeclared bytes' : '');
      }
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      await tar.create({ cwd: staging, file: archivePath, portable: true, noMtime: true }, ['manifest.json', ...manifest.entries.map((entry) => entry.path)]);
      await expect(extractVerifiedPersonalHomeArchiveSnapshot(archivePath, destination, { availableBytes: Number.MAX_SAFE_INTEGER, availableEntries: 100 })).rejects.toMatchObject({ code: 'hash_mismatch' });
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects archive entry counts and extracted bytes beyond measured destination capacity before extraction', async () => {
    const { root, layout } = await fixture();
    try {
      const backup = await createPersonalHomeBackup({
        layout, outputPath: join(layout.backupsDir, 'bounded.tar'), stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk,
      });
      const destinationByEntries = join(root, 'entries-destination');
      await expect(extractVerifiedPersonalHomeArchiveSnapshot(backup.path, destinationByEntries, { availableBytes: Number.MAX_SAFE_INTEGER, availableEntries: 2 })).rejects.toMatchObject({ code: 'resource_limit' });
      await expect(lstat(destinationByEntries)).rejects.toMatchObject({ code: 'ENOENT' });

      const destinationByBytes = join(root, 'bytes-destination');
      const extractedBytes = backup.manifest.entries.reduce((total, entry) => total + entry.size, 0);
      await expect(extractVerifiedPersonalHomeArchiveSnapshot(backup.path, destinationByBytes, { availableBytes: extractedBytes - 1, availableEntries: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: 'resource_limit' });
      await expect(lstat(destinationByBytes)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts implicit ancestor directories against destination entry capacity before extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-implicit-entry-capacity-'));
    try {
      const staging = join(root, 'staging');
      const archivePath = join(root, 'deep.tar');
      const destination = join(root, 'destination');
      const emptyHash = createHash('sha256').update('').digest('hex');
      const deepPath = `files/public/${Array.from({ length: 32 }, (_, index) => String(index % 10)).join('/')}/payload.txt`;
      const paths = [
        'database/home.sqlite',
        'secrets/handy-master-secret.txt',
        'configuration/home.env.json',
        deepPath,
      ];
      const manifest = parsePersonalHomeBackupManifest({
        format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
        schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
        databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
        entries: paths.map((path) => ({ path, size: 0, sha256: emptyHash })),
      });
      for (const path of paths) {
        const target = join(staging, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, '');
      }
      await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
      await tar.create({ cwd: staging, file: archivePath, portable: true, noMtime: true, noDirRecurse: true }, ['manifest.json', ...paths]);

      await expect(verifyPersonalHomeArchive(archivePath)).resolves.toMatchObject({ homeServerIdentityId: 'home-identity' });
      // The archive has five headers, but extraction also materializes each unique ancestor directory.
      await expect(extractVerifiedPersonalHomeArchiveSnapshot(archivePath, destination, {
        availableBytes: Number.MAX_SAFE_INTEGER,
        availableEntries: 5,
      })).rejects.toMatchObject({ code: 'resource_limit' });
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
      const filesystemEntries = new Set(['manifest.json', ...paths].flatMap((path) => {
        const components = path.split('/');
        return components.map((_, index) => components.slice(0, index + 1).join('/'));
      }));
      expect(filesystemEntries.size).toBeGreaterThan(5);
      await expect(extractVerifiedPersonalHomeArchiveSnapshot(archivePath, destination, {
        availableBytes: Number.MAX_SAFE_INTEGER,
        availableEntries: filesystemEntries.size,
      })).resolves.toMatchObject({ homeServerIdentityId: 'home-identity' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['COM¹', false], ['CONIN$', false], ['CONOUT$', false], ['report?.txt', false], ['a<b.txt', false],
    ['COM1-not-device.txt', true], ['CONIN-report.txt', true], ['report.txt', true], ['a-b.txt', true],
  ])('uses portable segment admission for backup file and directory %s', (name, accepted) => {
    const hash = createHash('sha256').update('').digest('hex');
    const path = `files/public/${name}`;
    const parse = () => parsePersonalHomeBackupManifest({
      format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
      schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: hash,
      databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
      entries: ['database/home.sqlite', 'secrets/handy-master-secret.txt', 'configuration/home.env.json', path]
        .map((entryPath) => ({ path: entryPath, size: 0, sha256: hash })),
    });
    if (accepted) expect(parse().entries).toContainEqual({ path, size: 0, sha256: hash });
    else expect(parse).toThrow(/Invalid Personal Home backup path/u);
    expect(isAllowedPersonalHomeBackupDirectoryPath(`${path}/`)).toBe(accepted);
  });

  it('rejects archive paths beyond the portable filesystem path boundary while retaining long valid v1 paths', () => {
    const emptyHash = createHash('sha256').update('').digest('hex');
    const path = `files/public/${Array.from({ length: 22 }, () => 'a'.repeat(200)).join('/')}/file.txt`;
    expect(Buffer.byteLength(path)).toBeGreaterThan(4096);
    expect(() => parsePersonalHomeBackupManifest({
      format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0',
      schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
      databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
      entries: [
        { path: 'database/home.sqlite', size: 0, sha256: emptyHash },
        { path: 'secrets/handy-master-secret.txt', size: 0, sha256: emptyHash },
        { path: 'configuration/home.env.json', size: 0, sha256: emptyHash },
        { path, size: 0, sha256: emptyHash },
      ],
    })).toThrow(/path.*long/u);
  });

  it('preserves empty public and private file directories through the verified archive', async () => {
    const { root, layout } = await fixture();
    try {
      await mkdir(join(layout.publicFilesDir, 'empty', 'nested'), { recursive: true });
      await mkdir(join(layout.privateFilesDir, 'empty-private'), { recursive: true });
      const result = await createPersonalHomeBackup({
        layout,
        outputPath: join(layout.backupsDir, 'empty-directories.tar'),
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      const extracted = join(root, 'extracted');

      await extractVerifiedPersonalHomeArchive(result.path, extracted);

      expect((await lstat(join(extracted, 'files/public/empty/nested'))).isDirectory()).toBe(true);
      expect((await lstat(join(extracted, 'files/private/empty-private'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('represents the empty root public and private file directories as archive directory entries', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-empty-roots-'));
    try {
      const layout = resolvePersonalHomeRuntimeLayout({ homeDir: root, platform: 'linux', mode: 'user' });
      await mkdir(layout.dataDir, { recursive: true });
      await mkdir(layout.publicFilesDir, { recursive: true });
      await mkdir(layout.privateFilesDir, { recursive: true });
      await writeFile(layout.databasePath, 'sqlite-fixture');
      await writeFile(layout.masterSecretPath, 'master-secret-fixture');
      const result = await createPersonalHomeBackup({
        layout,
        outputPath: join(layout.backupsDir, 'empty-roots.tar'),
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      const extracted = join(root, 'extracted');
      await extractVerifiedPersonalHomeArchive(result.path, extracted);
      expect((await lstat(join(extracted, 'files/public'))).isDirectory()).toBe(true);
      expect((await lstat(join(extracted, 'files/private'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects archive directory entries outside the fixed public and private file roots', { timeout: 30_000 }, async () => {
    const { root, layout } = await fixture();
    try {
      const outputPath = join(layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout, outputPath, stagingDir: join(root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
      });
      const stage = join(root, 'craft');
      await mkdir(stage, { recursive: true });
      await tar.extract({ file: outputPath, cwd: stage, strict: true, preservePaths: false, follow: false });
      await mkdir(join(stage, 'files/other'), { recursive: true });
      const baseNames = ['manifest.json', 'database/home.sqlite', 'secrets/handy-master-secret.txt', 'configuration/home.env.json', 'files/public', 'files/public/nested', 'files/public/nested/readme.txt', 'files/private', 'files/private/secret.txt'];
      const control = join(root, 'control.tar');
      await tar.create({ cwd: stage, file: control, portable: true, noMtime: true, follow: false, noDirRecurse: true }, baseNames);
      // The identical tree without the hostile directory entry verifies, so only its presence discriminates.
      await verifyPersonalHomeArchive(control);
      const hostile = join(root, 'hostile.tar');
      await tar.create({ cwd: stage, file: hostile, portable: true, noMtime: true, follow: false, noDirRecurse: true }, [...baseNames, 'files/other']);
      await expect(verifyPersonalHomeArchive(hostile)).rejects.toMatchObject({ code: 'invalid_archive' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects case-fold collisions between file and directory entries in the archive', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-case-fold-'));
    try {
      const hostile = join(root, 'hostile.tar');
      await writeStructuralTar(hostile, [
        { path: 'files/public/note.txt', type: 'File' },
        { path: 'files/public/NOTE.TXT/', type: 'Directory' },
      ]);
      await expect(verifyPersonalHomeArchive(hostile)).rejects.toMatchObject({ code: 'invalid_archive' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects case-fold aliases in implicit parent directories', () => {
    const emptyHash = createHash('sha256').update('').digest('hex');
    expect(() => parsePersonalHomeBackupManifest({
      format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0.0.0',
      schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
      databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
      entries: [
        { path: 'database/home.sqlite', size: 0, sha256: emptyHash },
        { path: 'secrets/handy-master-secret.txt', size: 0, sha256: emptyHash },
        { path: 'configuration/home.env.json', size: 0, sha256: emptyHash },
        { path: 'files/public/Folder/one.txt', size: 0, sha256: emptyHash },
        { path: 'files/public/folder/two.txt', size: 0, sha256: emptyHash },
      ],
    })).toThrow(/Case-fold collision/u);
  });

  it('keeps manifest v1 entries strictly file-only', () => {
    const emptyHash = createHash('sha256').update('').digest('hex');
    expect(() => parsePersonalHomeBackupManifest({
      format: 'happier-personal-home-backup', version: 1, createdAt: new Date(0).toISOString(), happierVersion: '0.0.0',
      schemaVersion: '1', homeServerIdentityId: 'home-identity', masterSecretFingerprint: emptyHash,
      databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: 'linux', sourceRuntimeMode: 'user',
      entries: [
        { path: 'database/home.sqlite', size: 0, sha256: emptyHash },
        { path: 'secrets/handy-master-secret.txt', size: 0, sha256: emptyHash },
        { path: 'configuration/home.env.json', size: 0, sha256: emptyHash },
        { path: 'files/public/empty', type: 'directory' },
      ],
    })).toThrow(/manifest entry fields/u);
  });

  it('rejects duplicate structural directory headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-duplicate-directory-'));
    try {
      const archivePath = join(root, 'duplicate.tar');
      await writeStructuralTar(archivePath, [
        { path: 'files/public/empty/', type: 'Directory' },
        { path: 'files/public/empty/', type: 'Directory' },
      ]);
      await expect(verifyPersonalHomeArchive(archivePath)).rejects.toMatchObject({ code: 'invalid_archive' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a structural directory beneath an archive file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-file-descendant-'));
    try {
      const archivePath = join(root, 'file-descendant.tar');
      await writeStructuralTar(archivePath, [
        { path: 'files/public/item', type: 'File' },
        { path: 'files/public/item/nested/', type: 'Directory' },
      ]);
      await expect(verifyPersonalHomeArchive(archivePath)).rejects.toMatchObject({ code: 'invalid_archive' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires the supplied SQLite checkpoint and quick-check callbacks before copying the database', async () => {
    const { root, layout } = await fixture();
    try {
      await expect(createPersonalHomeBackup({
        layout, outputPath: join(layout.backupsDir, 'quick-check.tar'), stagingDir: join(root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {},
        sqlite: { checkpoint: async () => ({ busy: 0 }), quickCheck: async () => false, close: async () => undefined },
      })).rejects.toMatchObject({ code: 'sqlite_check_failed' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores through a staged swap and restores the destination when post-swap health fails', async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => false,
        prepareConfiguration,
      });
      expect(result.outcome).toBe('rolled_back');
      expect(await readFile(destination.layout.databasePath, 'utf8')).toBe('destination-before-restore');
      // A completed rollback removes the recovery journal so future restores are not blocked.
      await expect(lstat(join(destination.layout.dataDir, '.operations', 'restore-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('restores the destination approval-required policy when post-activation restore validation fails', async () => {
    const source = await fixture();
    const destination = await fixture();
    const destinationEnvPath = join(destination.layout.configDir, 'server.env');
    try {
      const archivePath = join(source.layout.backupsDir, 'approval-policy-rollback.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging-approval-policy-rollback'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: { homeDeviceApprovalRequired: false },
        sqlite: sqliteOk,
      });
      await mkdir(destination.layout.configDir, { recursive: true });
      await writeFile(destinationEnvPath, [
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${destination.layout.dataDir}`,
        'HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1',
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'));

      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => false,
        prepareConfiguration: (configuration) => preparePersonalHomeSanitizedConfiguration(destination.layout, configuration),
      });

      expect(result.outcome).toBe('rolled_back');
      await expect(readFile(destinationEnvPath, 'utf8')).resolves.toContain('HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1');
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('restarts an untouched running Home when active SQLite validation fails after stop but before journaling', async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const events: string[] = [];
      let maintenanceCalls = 0;
      let running = true;
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        isHomeRunning: async () => running,
        stopHome: async () => { events.push('stop'); running = false; },
        startHome: async () => { events.push('start'); running = true; },
        healthCheck: async () => true,
        sqliteMaintenance: async () => {
          maintenanceCalls += 1;
          return maintenanceCalls === 1
            ? sqliteOk
            : { checkpoint: async () => ({ busy: 0 }), quickCheck: async () => false, close: async () => undefined };
        },
        prepareConfiguration,
      });
      expect(result.outcome).toBe('rolled_back');
      expect(events).toEqual(['stop', 'start']);
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-restore');
      await expect(lstat(join(destination.layout.dataDir, '.operations', 'restore-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('restarts an untouched running Home when stop reports failure after stopping it', async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const events: string[] = [];
      let running = true;
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        isHomeRunning: async () => running,
        stopHome: async () => {
          events.push('stop');
          running = false;
          throw new Error('service adapter reported failure after stopping');
        },
        startHome: async () => { events.push('start'); running = true; },
        healthCheck: async () => true,
        sqliteMaintenance: async () => sqliteOk,
        prepareConfiguration,
      });
      expect(result.outcome).toBe('rolled_back');
      expect(events).toEqual(['stop', 'start']);
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-restore');
      await expect(lstat(join(destination.layout.dataDir, '.operations', 'restore-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('rejects migration-produced SQLite sidecars after checkpoint and closed maintenance before destination mutation', async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const events: string[] = [];
      let stopped = false;
      let started = false;

      await expect(restorePersonalHomeBackupOwner({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        isSchemaSupported: async () => true,
        runMigrations: async (databasePath) => {
          await writeFile(`${databasePath}-wal`, 'migration-pending-wal');
        },
        sqliteMaintenance: async () => ({
          checkpoint: async () => { events.push('checkpoint'); return { busy: 0 }; },
          quickCheck: async () => { events.push('quick-check'); return true; },
          close: async () => { events.push('close'); },
        }),
        verifyStagedIdentity: async () => true,
        inspectConfigurationStorage: async () => ({ targetPath: join(destination.layout.configDir, 'server.env'), incomingBytes: 0, rollbackBytes: 0 }),
        prepareConfiguration,
        isHomeRunning: async () => false,
        stopHome: async () => { stopped = true; },
        startHome: async () => { started = true; },
      })).rejects.toMatchObject({ code: 'sqlite_snapshot_unstable' });

      expect(events).toEqual(['checkpoint', 'quick-check', 'close']);
      expect(stopped).toBe(false);
      expect(started).toBe(false);
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-restore');
      await expect(lstat(join(destination.layout.dataDir, '.operations', 'restore-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('keeps every explicit user backup after later backups verify', { timeout: 60_000 }, async () => {
    const { root, layout } = await fixture();
    try {
      for (let index = 0; index < 6; index += 1) {
        const result = await createPersonalHomeBackup({
          layout,
          outputPath: join(layout.backupsDir, `${index}.tar`),
          stagingDir: join(root, `staging-${index}`),
          homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
        });
        await verifyPersonalHomeArchive(result.path);
      }
      const exported = await createPersonalHomeBackup({
        layout,
        outputPath: join(root, 'exported-home.tar'),
        stagingDir: join(root, 'staging-export'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
      });
      await verifyPersonalHomeArchive(exported.path);
      expect((await readdir(layout.backupsDir)).filter((name) => name.endsWith('.tar')).sort()).toEqual([
        '0.tar', '1.tar', '2.tar', '3.tar', '4.tar', '5.tar',
      ]);
      expect((await stat(exported.path)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates extracted secret-bearing directories and files with restrictive POSIX permissions', async () => {
    if (process.platform === 'win32') return;
    const { root, layout } = await fixture();
    try {
      const result = await createPersonalHomeBackup({
        layout, outputPath: join(layout.backupsDir, 'permissions.tar'), stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
      });
      const extracted = join(root, 'extracted');
      await extractVerifiedPersonalHomeArchive(result.path, extracted);
      expect((await stat(extracted)).mode & 0o777).toBe(0o700);
      expect((await stat(join(extracted, 'database/home.sqlite'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(extracted, 'secrets/handy-master-secret.txt'))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preflights every simultaneously required target filesystem, including an external private-files root', async () => {
    const source = await fixture();
    const destination = await fixture();
    const externalPrivate = join(destination.root, 'external-private');
    const destinationLayout = { ...destination.layout, privateFilesDir: externalPrivate };
    try {
      const backup = await createPersonalHomeBackup({
        layout: source.layout, outputPath: join(source.layout.backupsDir, 'home.tar'), stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
      });
      const privateBytes = backup.manifest.entries
        .filter((entry) => entry.path.startsWith('files/private/'))
        .reduce((total, entry) => total + entry.size, 0);
      const inspected: string[] = [];
      await expect(restorePersonalHomeBackup({
        layout: destinationLayout,
        archivePath: backup.path,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        prepareConfiguration,
        readFilesystemCapacity: async (path) => {
          inspected.push(path);
          return path === externalPrivate
            ? { deviceId: 'private-device', availableBytes: Math.max(0, privateBytes - 1) }
            : { deviceId: 'data-device', availableBytes: Number.MAX_SAFE_INTEGER };
        },
      })).rejects.toMatchObject({ code: 'insufficient_space' });
      expect(inspected).toContain(dirname(destination.layout.dataDir));
      expect(inspected).toContain(externalPrivate);
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('checks the actual sibling staging filesystem instead of assuming the dataDir mount', async () => {
    const source = await fixture(); const destination = await fixture();
    try {
      const backup = await createPersonalHomeBackup({ layout: source.layout, outputPath: join(source.layout.backupsDir, 'home.tar'), stagingDir: join(source.root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk });
      const stagedBytes = backup.manifest.entries.reduce((total, entry) => total + entry.size, 0);
      const inspected: string[] = [];
      await expect(restorePersonalHomeBackup({
        layout: destination.layout, archivePath: backup.path, expectedHomeServerIdentityId: 'home-identity', confirmOverwrite: true, prepareConfiguration,
        readFilesystemCapacity: async (path) => { inspected.push(path); return path === dirname(destination.layout.dataDir) ? { deviceId: 'stage-device', availableBytes: stagedBytes - 1 } : { deviceId: 'target-device', availableBytes: Number.MAX_SAFE_INTEGER }; },
      })).rejects.toMatchObject({ code: 'insufficient_space' });
      expect(inspected).toContain(dirname(destination.layout.dataDir));
    } finally { await rm(source.root, { recursive: true, force: true }); await rm(destination.root, { recursive: true, force: true }); }
  });

  it('reports aggregate archive staging capacity exhaustion through the restore owner before lifecycle mutation', async () => {
    const source = await fixture(); const destination = await fixture();
    try {
      const backup = await createPersonalHomeBackup({ layout: source.layout, outputPath: join(source.layout.backupsDir, 'home.tar'), stagingDir: join(source.root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk });
      const declaredContentBytes = backup.manifest.entries.reduce((total, entry) => total + entry.size, 0);
      let stopped = false;
      await expect(restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath: backup.path,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        prepareConfiguration,
        isHomeRunning: async () => false,
        stopHome: async () => { stopped = true; },
        readFilesystemCapacity: async () => ({ deviceId: 'stage-device', availableBytes: declaredContentBytes, availableEntries: Number.MAX_SAFE_INTEGER }),
      })).rejects.toMatchObject({ code: 'insufficient_space' });
      expect(stopped).toBe(false);
    } finally { await rm(source.root, { recursive: true, force: true }); await rm(destination.root, { recursive: true, force: true }); }
  });

  for (const rollbackTarget of ['database', 'public', 'private', 'secret'] as const) {
    it(`accounts for existing ${rollbackTarget} bytes retained for rollback on its target filesystem`, async () => {
      const source = await fixture(); const destination = await fixture();
      try {
        const backup = await createPersonalHomeBackup({ layout: source.layout, outputPath: join(source.layout.backupsDir, 'home.tar'), stagingDir: join(source.root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk });
        const targetPath = rollbackTarget === 'database' ? destination.layout.databasePath : rollbackTarget === 'public' ? destination.layout.publicFilesDir : rollbackTarget === 'private' ? destination.layout.privateFilesDir : destination.layout.masterSecretPath;
        const existingBytes = rollbackTarget === 'database' ? (await stat(targetPath)).size : rollbackTarget === 'secret' ? (await stat(targetPath)).size : rollbackTarget === 'public' ? Buffer.byteLength('public') : Buffer.byteLength('private');
        const incomingBytes = backup.manifest.entries.filter((entry) => rollbackTarget === 'database' ? entry.path === 'database/home.sqlite' : rollbackTarget === 'secret' ? entry.path === 'secrets/handy-master-secret.txt' : entry.path.startsWith(`files/${rollbackTarget}/`)).reduce((total, entry) => total + entry.size, 0);
        await expect(restorePersonalHomeBackup({
          layout: destination.layout, archivePath: backup.path, expectedHomeServerIdentityId: 'home-identity', confirmOverwrite: true, prepareConfiguration,
          readFilesystemCapacity: async (path) => path === targetPath ? { deviceId: `${rollbackTarget}-device`, availableBytes: incomingBytes + existingBytes - 1 } : { deviceId: 'stage-device', availableBytes: Number.MAX_SAFE_INTEGER },
        })).rejects.toMatchObject({ code: 'insufficient_space' });
      } finally { await rm(source.root, { recursive: true, force: true }); await rm(destination.root, { recursive: true, force: true }); }
    });
  }

  it('accounts for the configuration owner temporary and rollback bytes on the config filesystem', async () => {
    const source = await fixture(); const destination = await fixture(); const configTarget = join(destination.layout.configDir, 'server.env');
    try {
      const backup = await createPersonalHomeBackup({ layout: source.layout, outputPath: join(source.layout.backupsDir, 'home.tar'), stagingDir: join(source.root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk });
      await expect(restorePersonalHomeBackup({
        layout: destination.layout, archivePath: backup.path, expectedHomeServerIdentityId: 'home-identity', confirmOverwrite: true, prepareConfiguration,
        inspectConfigurationStorage: async () => ({ targetPath: configTarget, incomingBytes: 20, rollbackBytes: 30 }),
        readFilesystemCapacity: async (path) => path === configTarget ? { deviceId: 'config-device', availableBytes: 49 } : { deviceId: 'other-device', availableBytes: Number.MAX_SAFE_INTEGER },
      })).rejects.toMatchObject({ code: 'insufficient_space' });
    } finally { await rm(source.root, { recursive: true, force: true }); await rm(destination.root, { recursive: true, force: true }); }
  });

  it('rolls back when a restored allowlisted file cannot actually be opened for reading', async () => {
    if (process.platform === 'win32') return;
    const source = await fixture();
    const destination = await fixture();
    try {
      const backup = await createPersonalHomeBackup({
        layout: source.layout, outputPath: join(source.layout.backupsDir, 'home.tar'), stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath: backup.path,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        prepareConfiguration,
        startHome: async () => { await chmod(join(destination.layout.privateFilesDir, 'secret.txt'), 0o000); },
      });
      expect(result.outcome).toBe('rolled_back');
      expect(await readFile(destination.layout.databasePath, 'utf8')).toBe('destination-before-restore');
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('fails closed for archive paths outside the fixed allowlist and link entries', { timeout: 30_000 }, async () => {
    const { root, layout } = await fixture();
    try {
      const outputPath = join(layout.backupsDir, 'home.tar');
      const result = await createPersonalHomeBackup({
        layout, outputPath, stagingDir: join(root, 'staging'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0.0.0', configuration: {}, sqlite: sqliteOk,
      });
      expect(() => parsePersonalHomeBackupManifest({ ...result.manifest, entries: [...result.manifest.entries, { path: '../outside', size: 1, sha256: 'a'.repeat(64) }] })).toThrow(/Invalid Personal Home backup path/u);
      const unexpectedStage = join(root, 'unexpected-stage');
      await mkdir(unexpectedStage, { recursive: true });
      await writeFile(join(unexpectedStage, 'unexpected.txt'), 'unexpected');
      await tar.create({ cwd: unexpectedStage, file: join(root, 'unexpected.tar'), portable: true }, ['unexpected.txt']);
      await expect(verifyPersonalHomeArchive(join(root, 'unexpected.tar'))).rejects.toMatchObject({ code: 'invalid_archive' });
      await symlink('unexpected.txt', join(unexpectedStage, 'files-link'));
      await tar.create({ cwd: unexpectedStage, file: join(root, 'link.tar'), portable: true, follow: false }, ['files-link']);
      await expect(verifyPersonalHomeArchive(join(root, 'link.tar'))).rejects.toMatchObject({ code: 'invalid_archive' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects backing up a present database without SQLite maintenance instead of copying it unchecked', async () => {
    const { root, layout } = await fixture();
    try {
      await expect(createPersonalHomeBackup({
        layout,
        outputPath: join(layout.backupsDir, 'unchecked.tar'),
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: undefined as never,
      })).rejects.toMatchObject({ code: 'sqlite_maintenance_required' });
      // Fail fast before any staging or publication happened.
      await expect(readdir(layout.backupsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects output inside archived file roots and through a symbolic-link ancestor', async () => {
    const { root, layout } = await fixture();
    try {
      await expect(createPersonalHomeBackup({ layout, outputPath: join(layout.publicFilesDir, 'nested', 'home.tar'), stagingDir: join(root, 'stage-public'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk })).rejects.toThrow(/output overlaps/u);
      const actual = join(root, 'actual-output'); const linked = join(root, 'linked-output'); await mkdir(actual); await symlink(actual, linked, 'dir');
      await expect(createPersonalHomeBackup({ layout, outputPath: join(linked, 'home.tar'), stagingDir: join(root, 'stage-link'), homeServerIdentityId: 'home-identity', schemaVersion: '1', happierVersion: '0', configuration: {}, sqlite: sqliteOk })).rejects.toThrow(/symbolic-link ancestor/u);
      await expect(lstat(join(actual, 'home.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('allows a platform-owned alias above an external output root without allowing a Home-controlled backup symlink', async () => {
    const external = await fixture();
    try {
      if (process.platform === 'darwin') {
        expect(await realpath(dirname(external.root))).not.toBe(resolve(dirname(external.root)));
      }
      const outputPath = join(external.root, 'external-home.tar');
      await expect(createPersonalHomeBackup({
        layout: external.layout,
        outputPath,
        stagingDir: join(external.root, 'external-stage'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0',
        configuration: {},
        sqlite: sqliteOk,
      })).resolves.toMatchObject({ path: outputPath });
    } finally {
      await rm(external.root, { recursive: true, force: true });
    }

    const linked = await fixture();
    try {
      const actualBackups = join(linked.layout.dataDir, 'redirected-backups');
      await mkdir(actualBackups);
      await symlink(actualBackups, linked.layout.backupsDir, 'dir');
      await expect(createPersonalHomeBackup({
        layout: linked.layout,
        outputPath: join(linked.layout.backupsDir, 'home.tar'),
        stagingDir: join(linked.root, 'linked-backup-stage'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0',
        configuration: {},
        sqlite: sqliteOk,
      })).rejects.toThrow(/symbolic-link ancestor/u);
      await expect(lstat(join(actualBackups, 'home.tar'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(linked.root, { recursive: true, force: true });
    }
  });

  it('restarts the Home from the owner finally when the snapshot check fails after stopping it', async () => {
    const { root, layout } = await fixture();
    try {
      const events: string[] = [];
      await expect(createPersonalHomeBackup({
        layout,
        outputPath: join(layout.backupsDir, 'unstable.tar'),
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: {
          checkpoint: async () => { events.push('checkpoint'); return { busy: 2 }; },
          quickCheck: async () => true,
          close: async () => { events.push('close'); },
        },
        wasRunning: true,
        stopHome: async () => { events.push('stop'); },
        startHome: async () => { events.push('start'); },
      })).rejects.toMatchObject({ code: 'sqlite_snapshot_unstable' });
      expect(events).toEqual(['stop', 'checkpoint', 'close', 'start']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to stop the Home for backup when no start callback can bring it back', async () => {
    const { root, layout } = await fixture();
    try {
      let stopped = false;
      await expect(createPersonalHomeBackup({
        layout,
        outputPath: join(layout.backupsDir, 'no-start.tar'),
        stagingDir: join(root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
        wasRunning: true,
        stopHome: async () => { stopped = true; },
      })).rejects.toThrow(/startHome/u);
      expect(stopped).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains transient rollback material until the verified restore owner finalizes only the recorded artifacts', { timeout: 30_000 }, async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: { canonicalServerUrl: 'http://127.0.0.1:43110' },
        sqlite: sqliteOk,
      });
      let appliedConfiguration: PersonalHomeRestorableConfigurationV1 | undefined;
      const rollbackArtifact = join(destination.layout.configDir, `server.env.${randomUUID()}.restore-rollback`);
      await mkdir(destination.layout.configDir, { recursive: true });
      await writeFile(rollbackArtifact, 'previous-configuration');
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => true,
        prepareConfiguration: async (configuration) => {
          return { rollbackArtifact, apply: async () => { appliedConfiguration = configuration; }, rollback: async () => undefined };
        },
      });
      expect(result.outcome).toBe('restored');
      expect(result.configurationArtifact).toBe('applied_by_owner');
      expect(appliedConfiguration).toMatchObject({ canonicalServerUrl: 'http://127.0.0.1:43110' });
      await expect(lstat(join(destination.layout.dataDir, 'configuration', 'home.env.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(inspectPersonalHomeRestoreRecovery(destination.layout)).resolves.toMatchObject({ status: 'finalization_available', phase: 'completed' });
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('sqlite-fixture');
      const rollbackPaths = result.rollbackPaths ?? [];
      expect(rollbackPaths.length).toBeGreaterThan(0);
      await expect(finalizePersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        finalizeConfiguration: async (artifact) => { expect(artifact).toBe(rollbackArtifact); await rm(artifact, { force: true }); },
      })).resolves.toMatchObject({ outcome: 'finalized' });
      for (const path of rollbackPaths) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(rollbackArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(destination.layout.dataDir, '.operations', 'restore-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it.each([true, false])('preserves Home device approval policy=%s through the backup/restore configuration artifact', async (homeDeviceApprovalRequired) => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'approval-policy.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging-approval-policy'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: { homeDeviceApprovalRequired },
        sqlite: sqliteOk,
      });
      let appliedConfiguration: PersonalHomeRestorableConfigurationV1 | undefined;
      const rollbackArtifact = join(destination.layout.configDir, `server.env.${randomUUID()}.restore-rollback`);
      await mkdir(destination.layout.configDir, { recursive: true });
      await writeFile(rollbackArtifact, 'previous-configuration');

      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => true,
        prepareConfiguration: async (configuration) => ({
          rollbackArtifact,
          apply: async () => { appliedConfiguration = configuration; },
          rollback: async () => undefined,
        }),
      });

      expect(result.outcome).toBe('restored');
      expect(appliedConfiguration).toMatchObject({ homeDeviceApprovalRequired });
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('does not restart a previously stopped destination when rolling back', { timeout: 30_000 }, async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const events: string[] = [];
      let running = false;
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        isHomeRunning: async () => running,
        stopHome: async () => { events.push('stop'); running = false; },
        startHome: async () => { events.push('start'); running = true; },
        healthCheck: async () => false,
        prepareConfiguration,
      });
      expect(result.outcome).toBe('rolled_back');
      // The already-stopped destination is not redundantly stopped. The restored candidate
      // starts for its health probe, is stopped on failure, and the previous Home stays stopped.
      expect(events).toEqual(['start', 'stop']);
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-restore');
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('rolls back an external private-files root without cross-volume rollback placement', { timeout: 30_000 }, async () => {
    const source = await fixture();
    const destination = await fixture();
    const externalPrivate = join(destination.root, 'external-private');
    const destinationLayout = { ...destination.layout, privateFilesDir: externalPrivate };
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await mkdir(externalPrivate, { recursive: true });
      await writeFile(join(externalPrivate, 'before.txt'), 'destination-private-before');
      const result = await restorePersonalHomeBackup({
        layout: destinationLayout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => false,
        prepareConfiguration,
      });
      expect(result.outcome).toBe('rolled_back');
      await expect(readFile(join(externalPrivate, 'before.txt'), 'utf8')).resolves.toBe('destination-private-before');
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('returns typed recovery and keeps the journal when the rollback itself fails, then refuses the next restore', { timeout: 60_000 }, async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => false,
        prepareConfiguration: async () => ({ rollbackArtifact: '/tmp/test-config-rollback', apply: async () => undefined, rollback: async () => { throw new Error('config rollback blocked'); } }),
      });
      expect(result.outcome).toBe('recovery_required');
      expect(result.rollbackPaths?.length).toBeGreaterThan(0);
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await expect(stat(journalPath)).resolves.toBeTruthy();
      // Until the recorded rollback is explicitly resolved, further restores fail closed.
      await expect(restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        healthCheck: async () => true,
        prepareConfiguration,
      })).rejects.toMatchObject({ code: 'recovery_required' });
      await expect(stat(journalPath)).resolves.toBeTruthy();
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('does not mutate promoted Home bytes when activation rollback cannot prove the Home stopped', { timeout: 60_000 }, async () => {
    const source = await fixture();
    const destination = await fixture();
    try {
      const archivePath = join(source.layout.backupsDir, 'home.tar');
      await createPersonalHomeBackup({
        layout: source.layout,
        outputPath: archivePath,
        stagingDir: join(source.root, 'staging'),
        homeServerIdentityId: 'home-identity',
        schemaVersion: '1',
        happierVersion: '0.0.0',
        configuration: {},
        sqlite: sqliteOk,
      });
      await writeFile(destination.layout.databasePath, 'destination-before-restore');
      let running = true;
      let stopCalls = 0;
      let configurationRollbackCalls = 0;
      const result = await restorePersonalHomeBackup({
        layout: destination.layout,
        archivePath,
        expectedHomeServerIdentityId: 'home-identity',
        confirmOverwrite: true,
        isHomeRunning: async () => running,
        stopHome: async () => {
          stopCalls += 1;
          if (stopCalls === 1) running = false;
          else throw new Error('service manager could not stop Home');
        },
        startHome: async () => { running = true; },
        healthCheck: async () => false,
        prepareConfiguration: async () => ({
          rollbackArtifact: '/tmp/test-config-rollback',
          apply: async () => undefined,
          rollback: async () => { configurationRollbackCalls += 1; },
        }),
      });

      expect(result.outcome).toBe('recovery_required');
      expect(stopCalls).toBe(2);
      expect(running).toBe(true);
      expect(configurationRollbackCalls).toBe(0);
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('sqlite-fixture');
      await expect(stat(join(destination.layout.dataDir, '.operations', 'restore-journal.json'))).resolves.toBeTruthy();
    } finally {
      await rm(source.root, { recursive: true, force: true });
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('does not stop a healthy Home when no restore journal exists', async () => {
    const destination = await fixture();
    try {
      let stopCalls = 0;
      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => true,
        stopHome: async () => { stopCalls += 1; },
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async () => undefined,
      })).resolves.toMatchObject({ outcome: 'rolled_back', restartedHome: false });
      expect(stopCalls).toBe(0);
    } finally {
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  for (const boundary of ['preserving', 'promoted'] as const) {
    it(`recovers exact previous bytes from a durable journal after the ${boundary} crash boundary`, async () => {
      const destination = await fixture();
      try {
        const id = randomUUID();
        const stage = `${destination.layout.dataDir}.restore-stage-789-${id}`;
        const journal = recoveryJournalFixture(destination.layout, stage, id);
        const rollback = `${destination.layout.databasePath}.restore-rollback-${id}`;
        await writeFile(rollback, 'destination-before-crash');
        if (boundary === 'preserving') await rm(destination.layout.databasePath);
        else await writeFile(destination.layout.databasePath, 'promoted-candidate');
        journal.phase = boundary === 'preserving' ? 'preserving' : 'promoting';
        journal.entries[0] = { ...journal.entries[0]!, rollback, hadTarget: true, state: boundary };
        const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
        await mkdir(join(destination.layout.dataDir, '.operations'), { recursive: true });
        await writeFile(journalPath, JSON.stringify(journal));
        const result = await recoverPersonalHomeRestoreWithLease({ layout: destination.layout, operationLeaseHeld: true, isHomeRunning: async () => false, stopHome: async () => undefined, startHome: async () => undefined, healthCheck: async () => true, recoverConfiguration: async () => undefined });
        expect(result.outcome).toBe('rolled_back');
        await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-crash');
        await expect(lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await rm(destination.root, { recursive: true, force: true }); }
    });
  }

  it('resumes recovery after rollback bytes were restored but the journal update was interrupted', async () => {
    const destination = await fixture();
    try {
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-790-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      journal.phase = 'rolling_back';
      journal.entries[0] = {
        ...journal.entries[0]!,
        hadTarget: true,
        state: 'rollback_started',
      };
      await writeFile(destination.layout.databasePath, 'destination-before-crash');
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));

      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => false,
        stopHome: async () => undefined,
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async () => undefined,
      })).resolves.toMatchObject({ outcome: 'rolled_back', restartedHome: false });
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-crash');
      await expect(lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('cleans a journaled cross-filesystem candidate without replacing the untouched active Home', async () => {
    const destination = await fixture();
    try {
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-791-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      const candidate = `${destination.layout.databasePath}.restore-candidate-${id}`;
      journal.entries[0] = { ...journal.entries[0]!, source: candidate };
      await writeFile(destination.layout.databasePath, 'active-before-interrupted-copy');
      await writeFile(candidate, 'partial-candidate');
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));

      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => false,
        stopHome: async () => undefined,
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async () => undefined,
      })).resolves.toMatchObject({ outcome: 'rolled_back', restartedHome: false });
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('active-before-interrupted-copy');
      await expect(lstat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(destination.root, { recursive: true, force: true });
    }
  });

  it('retains an ambiguous recovery journal instead of activating mixed bytes', async () => {
    const destination = await fixture();
    try {
      await writeFile(destination.layout.databasePath, 'promoted-candidate');
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-987-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      journal.phase = 'promoting';
      journal.entries[0] = { ...journal.entries[0]!, rollback: `${destination.layout.databasePath}.restore-rollback-${id}`, hadTarget: true, state: 'promoted' };
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(join(destination.layout.dataDir, '.operations'), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));
      await expect(recoverPersonalHomeRestoreWithLease({ layout: destination.layout, operationLeaseHeld: true, isHomeRunning: async () => false, stopHome: async () => undefined, startHome: async () => undefined, healthCheck: async () => true, recoverConfiguration: async () => undefined })).resolves.toMatchObject({ outcome: 'recovery_required' });
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('promoted-candidate');
      await expect(lstat(journalPath)).resolves.toBeTruthy();
    } finally { await rm(destination.root, { recursive: true, force: true }); }
  });

  it('proves the Home stopped before rejecting journal-controlled paths without mutating the filesystem', async () => {
    const destination = await fixture();
    try {
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-123-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      const outside = join(destination.root, 'outside-sentinel');
      await writeFile(outside, 'must-survive');
      journal.phase = 'promoting';
      journal.entries[0] = { ...journal.entries[0]!, target: outside, rollback: `${outside}.restore-rollback-${id}`, state: 'promoted' };
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));
      let stopped = false;
      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => !stopped,
        stopHome: async () => { stopped = true; },
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async () => undefined,
      })).resolves.toMatchObject({ outcome: 'recovery_required', restartedHome: false });
      expect(stopped).toBe(true);
      await expect(readFile(outside, 'utf8')).resolves.toBe('must-survive');
      await expect(lstat(journalPath)).resolves.toBeTruthy();
    } finally { await rm(destination.root, { recursive: true, force: true }); }
  });

  for (const phase of ['applying_configuration', 'activating'] as const) {
    it(`stops the Home before rejecting an out-of-layout configuration rollback artifact in the ${phase} phase`, async () => {
      const destination = await fixture();
      try {
        const id = randomUUID();
        const stage = `${destination.layout.dataDir}.restore-stage-654-${id}`;
        const journal = recoveryJournalFixture(destination.layout, stage, id);
        const outside = join(destination.root, `outside-${phase}`);
        await writeFile(outside, 'must-survive');
        journal.phase = phase;
        Object.assign(journal, { configurationRollbackArtifact: outside });
        journal.entries = journal.entries.map((entry, index) => index < 4 ? { ...entry, state: 'promoted' } : entry);
        const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
        await mkdir(dirname(journalPath), { recursive: true });
        await writeFile(journalPath, JSON.stringify(journal));
        let running = true;
        const calls = { isHomeRunning: 0, stopHome: 0, recoverConfiguration: 0 };

        await expect(recoverPersonalHomeRestoreWithLease({
          layout: destination.layout,
          operationLeaseHeld: true,
          isHomeRunning: async () => { calls.isHomeRunning += 1; return running; },
          stopHome: async () => { calls.stopHome += 1; running = false; },
          startHome: async () => undefined,
          healthCheck: async () => true,
          recoverConfiguration: async () => { calls.recoverConfiguration += 1; },
        })).resolves.toMatchObject({ outcome: 'recovery_required', restartedHome: false });
        expect(calls).toEqual({ isHomeRunning: 2, stopHome: 1, recoverConfiguration: 0 });
        await expect(readFile(outside, 'utf8')).resolves.toBe('must-survive');
        await expect(lstat(journalPath)).resolves.toBeTruthy();
      } finally { await rm(destination.root, { recursive: true, force: true }); }
    });
  }

  for (const symlinkLocation of ['configuration boundary', 'rollback artifact'] as const) {
    it(`stops the Home before rejecting a symbolic-link ${symlinkLocation} during restore recovery`, async () => {
      const destination = await fixture();
      try {
        const id = randomUUID();
        const stage = `${destination.layout.dataDir}.restore-stage-321-${id}`;
        const journal = recoveryJournalFixture(destination.layout, stage, id);
        const artifact = join(destination.layout.configDir, `server.env.${id}.restore-rollback`);
        const outside = join(destination.root, `outside-${symlinkLocation.replace(' ', '-')}`);
        journal.phase = 'applying_configuration';
        Object.assign(journal, { configurationRollbackArtifact: artifact });
        journal.entries = journal.entries.map((entry, index) => index < 4 ? { ...entry, state: 'promoted' } : entry);
        if (symlinkLocation === 'configuration boundary') {
          await mkdir(outside, { recursive: true });
          await writeFile(join(outside, `server.env.${id}.restore-rollback`), 'must-survive');
          await mkdir(dirname(destination.layout.configDir), { recursive: true });
          await symlink(outside, destination.layout.configDir, 'dir');
        } else {
          await mkdir(destination.layout.configDir, { recursive: true });
          await writeFile(outside, 'must-survive');
          await symlink(outside, artifact, 'file');
        }
        const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
        await mkdir(dirname(journalPath), { recursive: true });
        await writeFile(journalPath, JSON.stringify(journal));
        let running = true;
        const calls = { isHomeRunning: 0, stopHome: 0, recoverConfiguration: 0 };

        await expect(recoverPersonalHomeRestoreWithLease({
          layout: destination.layout,
          operationLeaseHeld: true,
          isHomeRunning: async () => { calls.isHomeRunning += 1; return running; },
          stopHome: async () => { calls.stopHome += 1; running = false; },
          startHome: async () => undefined,
          healthCheck: async () => true,
          recoverConfiguration: async () => { calls.recoverConfiguration += 1; },
        })).resolves.toMatchObject({ outcome: 'recovery_required', restartedHome: false });
        expect(calls).toEqual({ isHomeRunning: 2, stopHome: 1, recoverConfiguration: 0 });
        await expect(lstat(journalPath)).resolves.toBeTruthy();
      } finally { await rm(destination.root, { recursive: true, force: true }); }
    });
  }

  it('recovers a valid canonical configuration rollback artifact journal', async () => {
    const destination = await fixture();
    try {
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-741-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      const artifact = join(destination.layout.configDir, `server.env.${id}.restore-rollback`);
      journal.phase = 'applying_configuration';
      Object.assign(journal, { configurationRollbackArtifact: artifact });
      journal.entries = journal.entries.map((entry, index) => index < 4 ? { ...entry, state: 'promoted' } : entry);
      await mkdir(destination.layout.configDir, { recursive: true });
      await writeFile(artifact, 'previous-configuration');
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));
      const recoveredArtifacts: string[] = [];

      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => false,
        stopHome: async () => undefined,
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async (rollbackArtifact) => { recoveredArtifacts.push(rollbackArtifact); },
      })).resolves.toMatchObject({ outcome: 'rolled_back', restartedHome: false });
      expect(recoveredArtifacts).toEqual([artifact]);
      await expect(lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(destination.root, { recursive: true, force: true }); }
  });

  it('resumes filesystem rollback after configuration rollback was applied before its journal reference was cleared', async () => {
    const destination = await fixture();
    try {
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-742-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      const artifact = join(destination.layout.configDir, `server.env.${id}.restore-rollback`);
      const databaseRollback = `${destination.layout.databasePath}.restore-rollback-${id}`;
      journal.phase = 'rolling_back';
      Object.assign(journal, {
        configurationRollbackArtifact: artifact,
        configurationRollbackState: 'applied',
      });
      journal.entries[0] = {
        ...journal.entries[0]!,
        rollback: databaseRollback,
        hadTarget: true,
        state: 'promoted',
      };
      await writeFile(databaseRollback, 'destination-before-restore');
      await writeFile(destination.layout.databasePath, 'promoted-candidate');
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));
      let recoverConfigurationCalls = 0;

      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => false,
        stopHome: async () => undefined,
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async () => { recoverConfigurationCalls += 1; },
      })).resolves.toMatchObject({ outcome: 'rolled_back', restartedHome: false });
      expect(recoverConfigurationCalls).toBe(0);
      await expect(readFile(destination.layout.databasePath, 'utf8')).resolves.toBe('destination-before-restore');
      await expect(lstat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(destination.root, { recursive: true, force: true }); }
  });

  it('stops the Home before rejecting incomplete or reordered restore journals', async () => {
    const destination = await fixture();
    try {
      const id = randomUUID();
      const stage = `${destination.layout.dataDir}.restore-stage-456-${id}`;
      const journal = recoveryJournalFixture(destination.layout, stage, id);
      journal.entries.reverse();
      const journalPath = join(destination.layout.dataDir, '.operations', 'restore-journal.json');
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, JSON.stringify(journal));
      let stopped = false;
      await expect(recoverPersonalHomeRestoreWithLease({
        layout: destination.layout,
        operationLeaseHeld: true,
        isHomeRunning: async () => !stopped,
        stopHome: async () => { stopped = true; },
        startHome: async () => undefined,
        healthCheck: async () => true,
        recoverConfiguration: async () => undefined,
      })).resolves.toMatchObject({ outcome: 'recovery_required', restartedHome: false });
      expect(stopped).toBe(true);
      await expect(lstat(journalPath)).resolves.toBeTruthy();
    } finally { await rm(destination.root, { recursive: true, force: true }); }
  });
});

describe('Personal Home SQLite snapshot stability', () => {
  it('rejects non-empty WAL or SHM sidecars with a typed unstable-snapshot failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-sqlite-'));
    try {
      const databasePath = join(root, 'home.sqlite');
      await writeFile(databasePath, 'db-bytes');
      const assert = (): Promise<void> => assertStablePersonalHomeSqliteSnapshot({
        databasePath,
        checkpoint: async () => ({ busy: 0 }),
        quickCheck: async () => true,
      });
      await writeFile(`${databasePath}-wal`, 'pending-frames');
      await expect(assert()).rejects.toMatchObject({ code: 'sqlite_snapshot_unstable' });
      await rm(`${databasePath}-wal`, { force: true });
      await writeFile(`${databasePath}-shm`, 'shared-memory');
      await expect(assert()).rejects.toBeInstanceOf(PersonalHomeSqliteSnapshotError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts absent or zero-length sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-personal-home-sqlite-'));
    try {
      const databasePath = join(root, 'home.sqlite');
      await writeFile(databasePath, 'db-bytes');
      await writeFile(`${databasePath}-wal`, '');
      await expect(assertStablePersonalHomeSqliteSnapshot({
        databasePath,
        checkpoint: async () => ({ busy: 0 }),
        quickCheck: async () => true,
      })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
