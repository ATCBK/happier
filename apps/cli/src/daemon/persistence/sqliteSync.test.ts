import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openProtectedSqliteDatabaseSync,
  openProtectedSqliteDatabaseReaderSync,
  openSqliteDatabaseSync,
  resolveSqliteSupportedValueBatchSize,
} from './sqliteSync';

describe('sqliteSync', () => {
  it.runIf(process.platform !== 'win32')('refuses an unsafe reader directory without repairing or creating it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-sqlite-reader-directory-'));
    const dbPath = join(directory, 'memory.sqlite');
    try {
      const writer = openProtectedSqliteDatabaseSync(dbPath);
      writer.close();
      await chmod(directory, 0o755);
      expect(() => openProtectedSqliteDatabaseReaderSync(dbPath)).toThrow('unsafe group/world permissions');
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
      const missingDirectory = join(directory, 'absent');
      expect(() => openProtectedSqliteDatabaseReaderSync(join(missingDirectory, 'missing.sqlite'))).toThrow();
      await expect(stat(missingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('derives value batches from the supported bind boundary and the actual query shape', () => {
    expect(resolveSqliteSupportedValueBatchSize({
      // A max-length unspaced-script query can approach two terms per input
      // character; it must still leave room for an eligibility batch.
      fixedParameterCount: 2_049,
      parametersPerValue: 1,
    })).toBe(30_717);
    expect(() => resolveSqliteSupportedValueBatchSize({
      fixedParameterCount: 32_766,
      parametersPerValue: 1,
    })).toThrow('query shape exceeds');
  });

  it('opens a daemon-owned SQLite database through the neutral persistence owner', () => {
    const db = openSqliteDatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE records (value TEXT NOT NULL)');
      db.prepare('INSERT INTO records (value) VALUES (?)').run('persisted');

      expect(db.prepare('SELECT value FROM records').get()).toEqual({ value: 'persisted' });
    } finally {
      db.close();
    }
  });
});
