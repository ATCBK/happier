import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { openSummaryShardIndexDb } from './summaryShardIndexDb';
import { openDeepIndexDb } from './deepIndex/deepIndexDb';
import { enforceMemoryDiskBudgets } from './enforceMemoryDiskBudgets';
import { getSqliteFootprintBytes } from './sqliteFootprint';

// Count real filesystem reads without substituting SQLite or the budget owner.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

describe('enforceMemoryDiskBudgets', () => {
  it('measures each unchanged under-budget database footprint once without evicting its rows', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-budgets-under-'));
    const tier1Path = join(dir, 'memory.sqlite');
    const deepPath = join(dir, 'deep.sqlite');
    const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
    const deep = openDeepIndexDb({ dbPath: deepPath });
    try {
      tier1.init();
      deep.init();
      tier1.insertSummaryShard({ sessionId: 's1', seqFrom: 1, seqTo: 2,
        createdAtFromMs: 1, createdAtToMs: 2, summary: 'retainedsummary',
        keywords: [], entities: [], decisions: [] });
      deep.insertChunk({ sessionId: 's1', seqFrom: 1, seqTo: 2,
        createdAtFromMs: 1, createdAtToMs: 2, text: 'retainedchunk' });
      // Observe the OS boundary while retaining real SQLite persistence and enforcement.
      const stats = vi.mocked(stat);
      stats.mockClear();
      try {
        await enforceMemoryDiskBudgets({ tier1, deep, tier1DbPath: tier1Path, deepDbPath: deepPath,
          budgets: { tier1Bytes: Number.MAX_SAFE_INTEGER, deepBytes: Number.MAX_SAFE_INTEGER } });
        const paths = [tier1Path, deepPath].flatMap(path => [path, `${path}-wal`, `${path}-shm`]);
        expect(paths.map(path => stats.mock.calls.filter(([observed]) => observed === path).length))
          .toEqual([1, 1, 1, 1, 1, 1]);
        expect(tier1.search({ query: 'retainedsummary', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
        expect(deep.search({ query: 'retainedchunk', scope: { type: 'global' }, maxResults: 10 })).toHaveLength(1);
      } finally { stats.mockClear(); }
    } finally {
      deep.close();
      tier1.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('evicts tier-1 and deep rows when budgets are exceeded', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-budgets-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();

      tier1.insertSummaryShard({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        summary: 'termone',
        keywords: [],
        entities: [],
        decisions: [],
      });
      deep.insertChunk({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'termtwo',
      });
      const document = { ref: { serverId: 'home', artifactId: 'attached' }, revision: { headerVersion: 1, bodyVersion: 1 } };
      deep.replaceDocumentIndexData({ ...document, entries: [{ location: 'document', text: 'documentterm' }] });

      expect(tier1.search({ query: 'termone', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);
      expect(deep.search({ query: 'termtwo', scope: { type: 'global' }, maxResults: 10 }).length).toBe(1);

      await enforceMemoryDiskBudgets({
        tier1,
        deep,
        tier1DbPath: tier1Path,
        deepDbPath: deepPath,
        budgets: { tier1Bytes: 0, deepBytes: 0 },
      });

      expect(tier1.search({ query: 'termone', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'termtwo', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.searchDocuments({ query: 'documentterm', eligibleDocuments: [document], maxResults: 10 })).toEqual([]);
      expect(deep.getDeepIndexStats()).toMatchObject({ searchableDocumentCount: 0, deepDocumentEntryCount: 0 });

      deep.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('remeasures after checkpointing and evicts retained rows above a positive budget', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-budgets-positive-'));
    const tier1Path = join(dir, 'memory.sqlite');
    const deepPath = join(dir, 'deep.sqlite');
    const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
    const deep = openDeepIndexDb({ dbPath: deepPath });
    try {
      tier1.init();
      deep.init();
      tier1.checkpointAndVacuum();
      deep.checkpointAndVacuum();
      // The empty schema footprint is a real positive storage boundary.
      const budgets = { tier1Bytes: await getSqliteFootprintBytes(tier1Path),
        deepBytes: await getSqliteFootprintBytes(deepPath) };
      for (let index = 0; index < 64; index++) {
        tier1.insertSummaryShard({ sessionId: 's1', seqFrom: index + 1, seqTo: index + 1,
          createdAtFromMs: index + 1, createdAtToMs: index + 1, summary: 'positivebudget '.repeat(1024),
          keywords: [], entities: [], decisions: [] });
        deep.insertChunk({ sessionId: 's1', seqFrom: index + 1, seqTo: index + 1,
          createdAtFromMs: index + 1, createdAtToMs: index + 1, text: 'positivebudget '.repeat(1024) });
      }
      expect(await getSqliteFootprintBytes(tier1Path)).toBeGreaterThan(budgets.tier1Bytes);
      expect(await getSqliteFootprintBytes(deepPath)).toBeGreaterThan(budgets.deepBytes);
      vi.mocked(stat).mockClear();
      await enforceMemoryDiskBudgets({ tier1, deep, tier1DbPath: tier1Path, deepDbPath: deepPath, budgets });
      for (const path of [tier1Path, deepPath]) {
        expect(vi.mocked(stat).mock.calls.filter(([observed]) => observed === path).length).toBeGreaterThan(2);
      }
      // SQLite may retain schema/free pages after every evictable row is gone.
      expect(tier1.search({ query: 'positivebudget', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(deep.search({ query: 'positivebudget', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
    } finally {
      deep.close();
      tier1.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces the retained deep-index budget while its long-lived handle is closed', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'happier-memory-budgets-closed-deep-'));
    try {
      const tier1Path = join(dir, 'memory.sqlite');
      const deepPath = join(dir, 'deep.sqlite');
      const tier1 = openSummaryShardIndexDb({ dbPath: tier1Path });
      tier1.init();
      const deep = openDeepIndexDb({ dbPath: deepPath });
      deep.init();
      deep.insertChunk({
        sessionId: 's1',
        seqFrom: 1,
        seqTo: 2,
        createdAtFromMs: 1,
        createdAtToMs: 2,
        text: 'retained deep memory',
      });
      const document = { ref: { serverId: 'home', artifactId: 'retained' }, revision: { headerVersion: 1, bodyVersion: 1 } };
      deep.replaceDocumentIndexData({ ...document, entries: [{ factId: 'retained', location: 'archive', text: 'retaineddocument' }] });
      deep.close();

      await enforceMemoryDiskBudgets({
        tier1,
        deep: null,
        tier1DbPath: tier1Path,
        deepDbPath: deepPath,
        budgets: { tier1Bytes: Number.MAX_SAFE_INTEGER, deepBytes: 0 },
      });

      const reopened = openDeepIndexDb({ dbPath: deepPath });
      reopened.init();
      expect(reopened.search({ query: 'retained', scope: { type: 'global' }, maxResults: 10 })).toEqual([]);
      expect(reopened.searchDocuments({ query: 'retaineddocument', eligibleDocuments: [document], maxResults: 10 })).toEqual([]);
      expect(reopened.getDeepIndexStats()).toMatchObject({ searchableDocumentCount: 0, deepDocumentEntryCount: 0 });
      reopened.close();
      tier1.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
