import { expect, it } from 'vitest';
import {
  parseBuiltInLegacyConnectedServiceQuotaSnapshotV1,
  parseBuiltInLegacyProviderAccountUsageSnapshotV1,
} from './legacyConnectedServiceCompatibility.js';
import { ConnectedServiceQuotaSnapshotV1Schema } from './connectedServiceSchemas.js';

// Existing current-0.2 quota vector from the compatibility owner test. The
// predecessor credit kind and providerCreditId are translation, not extras.
const recoveryCredits = { kind: 'usage_limit_resets', availableCount: 1, totalCount: 2,
  source: 'provider_api', confidence: 'exact', credits: [{ providerCreditId: 'credit_123',
    kind: 'rate_limit_reset', status: 'available', expiresAtMs: 1700100000000 }] };
const meter = { meterId: 'five-hour', label: 'Five hour', used: 20, limit: 100, unit: 'credits',
  utilizationPct: 20, resetsAt: 1700100000000, status: 'ok', details: {} };
const quota = { v: 1, serviceId: 'openai-codex', profileId: 'work', fetchedAt: 1700000000000,
  staleAfterMs: 300000, planLabel: null, accountLabel: null, recoveryCredits, meters: [meter] };
const usage = { v: 1, recordId: 'paug_v1_D2ZqLYLAeVljfsjZqAF45dBhrB9Dkihcs1x1QuJJZxE', recordKey: {
  providerId: 'codex', accountSubjectId: 'acct_123', subjectKind: 'account', quotaScope: 'account' },
  providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'acct_123' },
  observedAtMs: 1700000000000, fetchedAtMs: 1700000000000, staleAfterMs: 300000,
  source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', recoveryCredits, meters: [meter] };

it('reads annotated current and predecessor quota/usage without losing translated credit identity', () => {
  const canonical = parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(quota);
  const canonicalUsage = parseBuiltInLegacyProviderAccountUsageSnapshotV1(usage);
  expect(canonical.recoveryCredits?.credits[0]?.id).toBe('credit_123');
  const annotations = { ...recoveryCredits, retired: true,
    credits: recoveryCredits.credits.map(credit => ({ ...credit, retired: true })) };
  expect(parseBuiltInLegacyConnectedServiceQuotaSnapshotV1({ ...quota, retired: true,
    recoveryCredits: annotations, meters: [{ ...meter, retired: true }] })).toEqual(canonical);
  expect(parseBuiltInLegacyProviderAccountUsageSnapshotV1({ ...usage, retired: true, recoveryCredits: annotations,
    recordKey: { ...usage.recordKey, retired: true }, accountSubject: { ...usage.accountSubject, retired: true } }))
    .toEqual(canonicalUsage);
  expect(parseBuiltInLegacyConnectedServiceQuotaSnapshotV1({ ...canonical, retired: true })).toEqual(canonical);
  expect(ConnectedServiceQuotaSnapshotV1Schema.safeParse({ ...canonical,
    recoveryCredits: { ...canonical.recoveryCredits, retired: true } }).success).toBe(false);
  expect(() => parseBuiltInLegacyConnectedServiceQuotaSnapshotV1({ ...quota,
    recoveryCredits: { ...annotations, totalCount: 0 } })).toThrow();
});
