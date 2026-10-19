import { describe, expect, it } from 'vitest';

import {
  SessionTranscriptObservationAckV1Schema,
  SessionTranscriptObservationV1Schema,
  SessionTranscriptObservationV2Schema,
  SessionHistoricalTranscriptImportV3Schema,
  isRecoveredHistoryTranscriptObservationProvenance,
  readSessionTranscriptSurfaceItemReferencesV1,
} from './transcriptObservationV1.js';

const observation = {
  v: 1 as const,
  sessionId: 'session-1',
  localId: ' historical-id ',
  content: { t: 'encrypted' as const, c: 'ciphertext' },
  createdAt: 100,
  updatedAt: 200,
  provenance: { kind: 'non_dependent' as const, source: 'history' as const },
};

describe('SessionTranscriptObservationV1', () => {
  it('opens retained surface associations without admitting extra fresh import fields', () => {
    const reference = { v: 1, itemId: 'child', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      sourceItemId: 'original', sourceItemRevision: null,
      sourceAddress: { serverId: 'home', sessionId: 'parent' } };
    const retained = { v: 1, retired: true, references: [{ ...reference, retired: true,
      sourceAddress: { ...reference.sourceAddress, retired: true } }] };
    expect(readSessionTranscriptSurfaceItemReferencesV1(retained)).toEqual([reference]);
    expect(readSessionTranscriptSurfaceItemReferencesV1({ ...retained,
      references: [{ ...reference, itemRevision: 'invalid' }] })).toBeNull();
    expect(SessionHistoricalTranscriptImportV3Schema.safeParse({ items: [{ localId: 'child',
      content: { t: 'encrypted', c: 'ciphertext' }, surfaceItemReference: retained }] }).success).toBe(false);
  });

  it('classifies retained history without relaxing fresh provenance admission', () => {
    const retained = { kind: 'non_dependent', source: 'history', retired: true };
    expect(isRecoveredHistoryTranscriptObservationProvenance(retained, 'stored')).toBe(true);
    expect(isRecoveredHistoryTranscriptObservationProvenance(retained)).toBe(false);
    expect(isRecoveredHistoryTranscriptObservationProvenance({ ...retained, source: 'external' }, 'stored')).toBe(false);
    expect(isRecoveredHistoryTranscriptObservationProvenance({ ...retained, kind: 'trusted' }, 'stored')).toBe(false);
  });

  it('preserves every exact original acknowledgement in one closed native row association', () => {
    const references = ['first', 'second'].map(itemId => ({ v: 1, itemId: `child-${itemId}`,
      itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', sourceItemId: itemId,
      sourceItemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      sourceAddress: { serverId: 'origin-home', sessionId: 'parent-session' } }));
    const surfaceItemReference = { v: 1, references };
    const row = { localId: 'native-two-results', content: { t: 'encrypted', c: 'unchanged-native-row' }, surfaceItemReference };
    expect(SessionHistoricalTranscriptImportV3Schema.parse({ items: [row] })).toEqual({ items: [row] });
    expect(SessionTranscriptObservationV2Schema.parse({ ...observation, v: 2, surfaceItemReference }))
      .toEqual({ ...observation, v: 2, surfaceItemReference });
    expect(SessionHistoricalTranscriptImportV3Schema.safeParse({ items: [{ ...row,
      surfaceItemReference: { ...surfaceItemReference, references: [{ ...references[0], authorToken: 'forged' }] } }] }).success).toBe(false);
  });
  it('preserves a child identity and original correlation in the strict historical import epoch', () => {
    const body = { items: [{ localId: 'child-row', content: { t: 'encrypted', c: 'child-sealed' },
      surfaceItemReference: { v: 1, itemId: 'child-item', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
        sourceAddress: { serverId: 'origin-home', sessionId: 'parent-session' } } }] };
    expect(SessionHistoricalTranscriptImportV3Schema.parse(body)).toEqual({ items: [{ ...body.items[0],
      surfaceItemReference: { v: 1, references: [body.items[0].surfaceItemReference] } }] });
    expect(SessionHistoricalTranscriptImportV3Schema.safeParse({ items: [{ ...body.items[0],
      surfaceItemReference: { ...body.items[0].surfaceItemReference, authorToken: 'forged' } }] }).success).toBe(false);
  });
  it('admits a surface association only in the negotiated closed observation epoch', () => {
    const surfaceItemReference = { v: 1, itemId: 'visual', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
      sourceAddress: { serverId: 'home-a', sessionId: 'session-1' } };
    expect(SessionTranscriptObservationV1Schema.safeParse({ ...observation, surfaceItemReference }).success).toBe(false);
    expect(SessionTranscriptObservationV2Schema.parse({ ...observation, v: 2, surfaceItemReference }))
      .toEqual({ ...observation, v: 2, surfaceItemReference: { v: 1, references: [surfaceItemReference] } });
    expect(SessionTranscriptObservationV2Schema.safeParse({ ...observation, v: 2,
      surfaceItemReference: { ...surfaceItemReference, authorToken: 'forged' } }).success).toBe(false);
  });

  it('preserves an exact nonblank local id and explicit content envelope', () => {
    expect(SessionTranscriptObservationV1Schema.parse(observation)).toEqual(observation);
  });

  it('rejects blank ids, inverted chronology, and expanded provenance', () => {
    expect(SessionTranscriptObservationV1Schema.safeParse({ ...observation, localId: '   ' }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({ ...observation, updatedAt: 99 }).success).toBe(false);
    expect(SessionTranscriptObservationV1Schema.safeParse({
      ...observation,
      provenance: { ...observation.provenance, trusted: true },
    }).success).toBe(false);
  });

  it('requires an exact observation acknowledgement', () => {
    expect(SessionTranscriptObservationAckV1Schema.safeParse({
      ok: true,
      status: 'observed',
      id: 'message-1',
      seq: 1,
      localId: ' historical-id ',
      didWrite: true,
      ingestedAt: 300,
    }).success).toBe(true);
  });

  it('classifies only strict recovered-history provenance', () => {
    expect(isRecoveredHistoryTranscriptObservationProvenance({
      kind: 'non_dependent',
      source: 'history',
    })).toBe(true);
    for (const source of ['background', 'external', 'sidechain'] as const) {
      expect(isRecoveredHistoryTranscriptObservationProvenance({
        kind: 'non_dependent',
        source,
      })).toBe(false);
    }
    expect(isRecoveredHistoryTranscriptObservationProvenance({
      kind: 'non_dependent',
      source: 'history',
      trusted: true,
    })).toBe(false);
    for (const absent of [undefined, null]) {
      expect(isRecoveredHistoryTranscriptObservationProvenance(absent)).toBe(false);
      expect(isRecoveredHistoryTranscriptObservationProvenance(absent, 'stored')).toBe(false);
    }
  });
});
