import { describe, expect, it } from 'vitest';

import {
  parseSessionMessageDeliveryResolutionV1,
  readStoredSessionMessageDeliveryResolutionV1,
  SessionMessageDeliveryResolutionV1Schema,
} from './sessionMessageDeliveryResolutionV1.js';

describe('SessionMessageDeliveryResolutionV1', () => {
  const facts = { v: 1, acceptedAtMs: 1234, delivery: { kind: 'newTurn', turnId: 'turn-1' } } as const;

  it.each([
    { canonical: { v: 1, kind: 'manual_handled' }, stored: { v: 1, kind: 'manual_handled', retired: true } },
    { canonical: { v: 1, kind: 'provider_accepted', content: { t: 'encrypted', c: 'sealed-facts' } },
      stored: { v: 1, kind: 'provider_accepted', retired: true, content: { t: 'encrypted', c: 'sealed-facts', retired: true } } },
    { canonical: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: facts } },
      stored: { v: 1, kind: 'provider_accepted', retired: true, content: { t: 'plain', retired: true, v: {
        ...facts, retired: true, delivery: { ...facts.delivery, retired: true },
      } } } },
  ])('opens retained $canonical.kind facts without relaxing fresh admission', ({ canonical, stored }) => {
    expect(parseSessionMessageDeliveryResolutionV1(stored)).toBeNull();
    expect(readStoredSessionMessageDeliveryResolutionV1(stored)).toEqual(canonical);
    expect(SessionMessageDeliveryResolutionV1Schema.parse(canonical)).toEqual(canonical);
  });

  it('refuses malformed known stored delivery facts instead of deriving acceptance from retired fields', () => {
    for (const stored of [
      { v: 2, kind: 'manual_handled', retired: true },
      { v: 1, kind: 'provider_accepted', retired: true, content: { t: 'encrypted', c: '' } },
      { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: { ...facts, acceptedAtMs: -1, retired: true } } },
      { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: { ...facts, delivery: { ...facts.delivery, turnId: ' ', retired: true } } } },
    ]) expect(readStoredSessionMessageDeliveryResolutionV1(stored)).toBeNull();
  });

  it('accepts only the minimal manual-handled provenance', () => {
    expect(SessionMessageDeliveryResolutionV1Schema.parse({ v: 1, kind: 'manual_handled' })).toEqual({
      v: 1,
      kind: 'manual_handled',
    });
    expect(parseSessionMessageDeliveryResolutionV1({ v: 1, kind: 'provider_accepted' })).toBeNull();
    expect(parseSessionMessageDeliveryResolutionV1({ v: 1, kind: 'manual_handled', receipt: 'extra' })).toBeNull();
  });
});
