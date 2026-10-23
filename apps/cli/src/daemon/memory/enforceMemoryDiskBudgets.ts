import type { SummaryShardIndexDbHandle } from './summaryShardIndexDb';
import { openDeepIndexDb, type DeepIndexDbHandle } from './deepIndex/deepIndexDb';

import { getSqliteFootprintBytes } from './sqliteFootprint';

async function enforceSqliteBudget(params: Readonly<{
  dbPath: string;
  budgetBytes: number;
  deleteBatch: (limit: number) => number;
  vacuum: () => void;
}>): Promise<void> {
  const budget = Number.isFinite(params.budgetBytes) ? Math.max(0, Math.trunc(params.budgetBytes)) : 0;
  if (budget === 0) {
    for (;;) {
      const deleted = params.deleteBatch(50);
      if (deleted <= 0) break;
      params.vacuum();
    }
    return;
  }

  // WAL growth is often fully reclaimable without evicting useful rows. Ask
  // the incumbent DB owner to checkpoint first, then charge the remaining
  // physical main/WAL/SHM footprint to the configured budget.
  if (await getSqliteFootprintBytes(params.dbPath) <= budget) return;
  params.vacuum();

  for (;;) {
    const size = await getSqliteFootprintBytes(params.dbPath);
    if (size <= budget) return;
    const deleted = params.deleteBatch(50);
    if (deleted <= 0) return;
    params.vacuum();
  }
}

export async function enforceMemoryDiskBudgets(params: Readonly<{
  tier1: SummaryShardIndexDbHandle;
  deep: DeepIndexDbHandle | null;
  tier1DbPath: string;
  deepDbPath: string;
  budgets: Readonly<{ tier1Bytes: number; deepBytes: number }>;
}>): Promise<void> {
  await enforceSqliteBudget({
    dbPath: params.tier1DbPath,
    budgetBytes: params.budgets.tier1Bytes,
    deleteBatch: (limit) => params.tier1.deleteOldestSummaryShards({ limit }),
    vacuum: () => params.tier1.checkpointAndVacuum(),
  });

  const normalizedDeepBudget = Number.isFinite(params.budgets.deepBytes)
    ? Math.max(0, Math.trunc(params.budgets.deepBytes))
    : 0;
  const retainedDeepNeedsEnforcement = params.deep === null
    && await getSqliteFootprintBytes(params.deepDbPath) > normalizedDeepBudget;
  const deep = params.deep ?? (retainedDeepNeedsEnforcement
    ? openDeepIndexDb({ dbPath: params.deepDbPath })
    : null);
  if (deep) {
    if (deep !== params.deep) deep.init();
    try {
      await enforceSqliteBudget({
        dbPath: params.deepDbPath,
        budgetBytes: params.budgets.deepBytes,
        deleteBatch: (limit) => deep.deleteOldestChunks({ limit }),
        vacuum: () => deep.checkpointAndVacuum(),
      });
    } finally {
      if (deep !== params.deep) deep.close();
    }
  }
}
