import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readProcessInstanceFingerprintSync } from '../../processInstance.mjs';
import {
  createHappierTempDir,
  getHappierTempRoot,
  getHappierTempDirOwnerPath,
  readHappierTempDirOwner,
  readHappierTempDirOwnerLiveness,
  prepareHappierTempDirOwnerCleanup,
  removeHappierTempDir,
} from './createHappierTempDir.js';

describe('Happier temporary directory ownership', () => {
  it('keeps captured markers when their ownership changes or the original directory is recreated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-temp-owner-capture-'));
    try {
      const directory = createHappierTempDir({ purpose: 'capture', root });
      const marker = getHappierTempDirOwnerPath(directory);
      const cleanup = prepareHappierTempDirOwnerCleanup(directory);
      const owner = readHappierTempDirOwner(directory)!;
      const replacement = JSON.stringify({ ...owner, pid: owner.pid + 1 });
      renameSync(directory, join(root, 'moved'));
      writeFileSync(marker, replacement);
      await cleanup();
      expect(readFileSync(marker, 'utf8')).toBe(replacement);

      const capturedReplacement = prepareHappierTempDirOwnerCleanup(directory);
      mkdirSync(directory);
      await capturedReplacement();
      expect(readFileSync(marker, 'utf8')).toBe(replacement);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('creates private user-scoped directories with sibling process ownership and no injected contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-temp-owner-test-'));
    try {
      if (process.platform !== 'win32') chmodSync(root, 0o755);
      const beforeMode = statSync(root).mode & 0o777;
      const directory = createHappierTempDir({ purpose: 'fixture', root });
      const second = createHappierTempDir({ purpose: 'fixture', root });
      expect(directory).not.toBe(second);
      expect(dirname(directory)).toBe(getHappierTempRoot(root));
      expect(basename(directory)).toMatch(/^fixture-.{6}$/u);
      expect(basename(dirname(directory))).toBe(process.platform === 'win32'
        ? basename(getHappierTempRoot(root)) : `happier-${userInfo().uid}`);
      expect(readdirSync(directory)).toEqual([]);
      expect(statSync(root).mode & 0o777).toBe(beforeMode);
      const owner = readHappierTempDirOwner(directory);
      expect(owner).toEqual({ v: 1, purpose: 'fixture', pid: process.pid,
        processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid) });
      expect(readHappierTempDirOwnerLiveness(owner!)).toBe(owner?.processInstanceFingerprint ? 'alive' : 'unknown');
      if (process.platform !== 'win32') {
        expect(statSync(dirname(directory)).mode & 0o777).toBe(0o700);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(getHappierTempDirOwnerPath(directory)).mode & 0o777).toBe(0o600);
      }
      removeHappierTempDir(directory);
      removeHappierTempDir(directory);
      expect(() => statSync(directory)).toThrow();
      expect(() => statSync(getHappierTempDirOwnerPath(directory))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never treats an unavailable start witness as gone, and detects a reused PID', () => {
    expect(readHappierTempDirOwnerLiveness({ v: 1, purpose: 'fixture', pid: process.pid, processInstanceFingerprint: null })).toBe('unknown');
    if (readProcessInstanceFingerprintSync(process.pid)) {
      expect(readHappierTempDirOwnerLiveness({ v: 1, purpose: 'fixture', pid: process.pid,
        processInstanceFingerprint: 'different-process-instance' })).toBe('gone');
    }
  });

  it('resolves an existing trusted temp parent physically without following the private user-root leaf', () => {
    if (process.platform === 'win32') return;
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'happier-temp-owner-parent-')));
    try {
      const target = mkdtempSync(join(fixture, 'target-'));
      const alias = join(fixture, 'alias');
      symlinkSync(target, alias);
      const expectedRoot = join(target, `happier-${userInfo().uid}`);
      expect(getHappierTempRoot(alias)).toBe(expectedRoot);
      const directory = createHappierTempDir({ purpose: 'fixture', root: alias });
      expect(dirname(directory)).toBe(expectedRoot);
      expect(directory).toBe(realpathSync(directory));
      expect(readHappierTempDirOwner(directory)?.purpose).toBe('fixture');
      removeHappierTempDir(directory);

      // Discovery does not pretend an unavailable parent was resolved. Creation
      // resolves it once recursive mkdir has made the trusted parent available.
      const missingRoot = join(alias, 'not-created-yet');
      expect(getHappierTempRoot(missingRoot)).toBe(join(missingRoot, `happier-${userInfo().uid}`));
      const laterDirectory = createHappierTempDir({ purpose: 'fixture', root: missingRoot });
      expect(dirname(laterDirectory)).toBe(getHappierTempRoot(missingRoot));
      expect(laterDirectory).toBe(realpathSync(laterDirectory));
      removeHappierTempDir(laterDirectory);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('recognizes a real creator process that has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const pid = child.pid!;
    const fingerprint = readProcessInstanceFingerprintSync(pid);
    const exit = once(child, 'exit');
    child.kill();
    await exit;
    expect(readHappierTempDirOwnerLiveness({ v: 1, purpose: 'fixture', pid, processInstanceFingerprint: fingerprint })).toBe(fingerprint ? 'gone' : 'unknown');
  });

  it('projects stored marker fields and refuses missing, malformed, or symlinked markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-temp-owner-reader-'));
    try {
      const directory = createHappierTempDir({ purpose: 'fixture', root });
      const marker = getHappierTempDirOwnerPath(directory);
      const original: unknown = JSON.parse(readFileSync(marker, 'utf8'));
      writeFileSync(marker, JSON.stringify({ ...(original as object), future: 'ignored' }));
      expect(readHappierTempDirOwner(directory)).toEqual(original);
      writeFileSync(marker, '{');
      expect(readHappierTempDirOwner(directory)).toBeNull();
      writeFileSync(marker, JSON.stringify({ v: 1, purpose: 'fixture', pid: process.pid, processInstanceFingerprint: 1 }));
      expect(readHappierTempDirOwner(directory)).toBeNull();
      rmSync(marker);
      expect(readHappierTempDirOwner(directory)).toBeNull();
      if (process.platform !== 'win32') {
        const other = join(root, 'other.json');
        writeFileSync(other, JSON.stringify(original));
        symlinkSync(other, marker);
        expect(readHappierTempDirOwner(directory)).toBeNull();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects escaped purposes and a symlinked user temp root', () => {
    expect(() => createHappierTempDir({ purpose: '../escape' })).toThrow(/purpose/u);
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'happier-temp-owner-root-'));
    try {
      const target = mkdtempSync(join(root, 'target-'));
      symlinkSync(target, getHappierTempRoot(root));
      expect(() => createHappierTempDir({ purpose: 'fixture', root })).toThrow(/directory/u);
      expect(readdirSync(target)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
