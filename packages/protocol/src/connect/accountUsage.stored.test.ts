import { expect, it } from 'vitest';
import {
  buildProviderAccountUsageRecordId,
  openSealedProviderAccountUsageSnapshot,
  ProviderAccountUsageSnapshotV1Schema,
  sealProviderAccountUsageSnapshot,
  sealProviderAccountUsageSnapshotCiphertext,
  SealedProviderAccountUsageSnapshotV1Schema,
} from './accountUsage.js';

it('opens annotated retained supplemental usage facets and retains their snapshot binding', () => {
  const recordKey = { providerId: 'codex', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: 'account' }, observedAtMs: 10, fetchedAtMs: 10,
    staleAfterMs: 100, source: 'providerHttp', confidence: 'confirmed', meters: [],
    recoveryCreditDetails: { grant: { remainingCount: 2 } },
    subscription: { status: 'subscribed', renewal: 'on', observedAtMs: 10, staleAfterMs: 100,
      enteredMonthlyPrice: { amount: 20, currency: 'USD', enteredAtMs: 1 } } });
  const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
  const randomBytes = (length: number) => new Uint8Array(length).fill(3);
  const sealed = sealProviderAccountUsageSnapshot({ material, snapshot, randomBytes });
  expect(openSealedProviderAccountUsageSnapshot({ material, sealed })).toEqual(snapshot);
  const encryptedRecovery = sealProviderAccountUsageSnapshotCiphertext({ material, randomBytes,
    payload: { v: 1, recordId: snapshot.recordId, fetchedAtMs: snapshot.fetchedAtMs, retired: true,
      recoveryCreditDetails: { grant: { ...snapshot.recoveryCreditDetails?.grant, retired: true } } } });
  const encryptedSubscription = sealProviderAccountUsageSnapshotCiphertext({ material, randomBytes,
    payload: { v: 1, recordId: snapshot.recordId, retired: true,
      subscription: { ...snapshot.subscription, retired: true,
        enteredMonthlyPrice: { ...snapshot.subscription?.enteredMonthlyPrice, retired: true } } } });
  const retained = { ...sealed, subscription: { observedAtMs: 10, ciphertext: encryptedSubscription, retired: true },
    recoveryCreditDetails: { ciphertext: encryptedRecovery, retired: true } };
  expect(openSealedProviderAccountUsageSnapshot({ material, sealed: retained })).toEqual(snapshot);
  expect(SealedProviderAccountUsageSnapshotV1Schema.safeParse(retained).success).toBe(false);
  expect(openSealedProviderAccountUsageSnapshot({ material, sealed: { ...retained,
    subscription: { ...retained.subscription, observedAtMs: 11 } } })).toBeNull();
  const mismatched = sealProviderAccountUsageSnapshotCiphertext({ material, randomBytes,
    payload: { v: 1, recordId: snapshot.recordId, fetchedAtMs: 11,
      recoveryCreditDetails: snapshot.recoveryCreditDetails, retired: true } });
  expect(openSealedProviderAccountUsageSnapshot({ material, sealed: { ...retained,
    recoveryCreditDetails: { ciphertext: mismatched } } })).toBeNull();
});
