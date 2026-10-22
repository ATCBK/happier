import { expect, it } from 'vitest';
import { readUsageAccountingMetadata, UsageAccountingMetadataSchema, UsageAnalyticsCostFactSchema } from './usageAnalyticsContracts.js';

it('reads stored accounting evidence by dropping extras but rejects invalid known fields', () => {
  expect(readUsageAccountingMetadata({ usageAccounting: { inferenceId: 'inference', status: 'pending', extra: 'drop',
    runtimeEventOrder: { runtimeIncarnationId: 'runtime', sequence: 2, future: 'drop' },
  } })).toEqual({ inferenceId: 'inference', status: 'pending', runtimeEventOrder: { runtimeIncarnationId: 'runtime', sequence: 2 } });
  expect(readUsageAccountingMetadata({ usageAccounting: { status: 'fabricated' } })).toBeNull();
  expect(readUsageAccountingMetadata({ usageAccounting: { runtimeEventOrder: { runtimeIncarnationId: 'runtime', sequence: -1 } } })).toBeNull();
  expect(UsageAccountingMetadataSchema.safeParse({ status: 'available', extra: 'drop' }).success).toBe(false);
});

it('retains explicit vendor counter overlap semantics for disjoint display projection', () => {
  expect(readUsageAccountingMetadata({ usageAccounting: { inputIncludesCache: true, outputIncludesReasoning: true } })).toEqual({ inputIncludesCache: true, outputIncludesReasoning: true });
});

it('rejects zero money masquerading as an unpriced fact', () => {
  const fact = { kind: 'unpriced', amountUsd: 0, currency: 'USD', source: 'none', tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 }, eventCount: 1, complete: false, asOfMs: 10 };
  expect(UsageAnalyticsCostFactSchema.safeParse(fact).success).toBe(false);
});
