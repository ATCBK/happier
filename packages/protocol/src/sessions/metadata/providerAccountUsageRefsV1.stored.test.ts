import { expect, it } from 'vitest';
import { ProviderAccountUsageRefsV1Schema, writeProviderAccountUsageRecordIdToMetadata } from './providerAccountUsageRefsV1.js';
import { buildProviderAccountUsageRecordId } from '../../connect/providerAccountUsagePrimitives.js';

it('does not restamp unchanged retained usage references because of retired annotations', () => {
  const recordId = buildProviderAccountUsageRecordId({ providerId: 'codex', accountSubjectId: 'acct_1',
    subjectKind: 'account', quotaScope: 'account' });
  const retained = { v: 1, recordIds: [recordId], updatedAtMs: 1000, retired: true };
  expect(writeProviderAccountUsageRecordIdToMetadata({ providerAccountUsageRefsV1: retained }, { recordId, updatedAtMs: 2000 }))
    .toEqual({ providerAccountUsageRefsV1: { v: 1, recordIds: [recordId], updatedAtMs: 1000 } });
  expect(ProviderAccountUsageRefsV1Schema.safeParse(retained).success).toBe(false);
});
