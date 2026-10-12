import { describe, expect, it } from 'vitest';

import { parseModelPackPromotionIntentV1, parseStoredModelPackPromotionIntentV1 } from './promotionRecovery.js';

const intent = {
  schemaVersion: 1,
  packId: 'pack-a',
  phase: 'metadata_pending',
  startedAtMs: 100,
  token: 'token-a',
  priorInstall: { scopeKey: 'scope-a', identityKey: 'identity-a' },
  recovery: { kind: 'owner-a', value: { opaqueOwnerData: true } },
} as const;

describe('model-pack promotion intent admission', () => {
  it('does not satisfy the required recovery value from an inherited property', () => {
    const recovery: Record<string, unknown> = Object.create({ value: null });
    recovery.kind = 'owner-a';
    expect(() => parseModelPackPromotionIntentV1({ ...intent, recovery }, intent.packId)).toThrow('model_pack_promotion_intent_invalid');
    expect(() => parseStoredModelPackPromotionIntentV1({ ...intent, recovery }, intent.packId)).toThrow('model_pack_promotion_intent_invalid');
  });

  it('projects stored fields recursively while preserving strict input admission and owner payloads', () => {
    const stored = { ...intent, retired: true,
      priorInstall: { ...intent.priorInstall, retired: true },
      recovery: { ...intent.recovery, retired: true } };
    expect(parseStoredModelPackPromotionIntentV1(stored, intent.packId)).toEqual(intent);
    expect(() => parseModelPackPromotionIntentV1(stored, intent.packId)).toThrow('model_pack_promotion_intent_invalid');
  });

  it.each([
    { ...intent, packId: 'another-pack' },
    { ...intent, startedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...intent, token: ' token-a' },
    { ...intent, priorInstall: { ...intent.priorInstall, identityKey: 12 } },
    { ...intent, recovery: { kind: 'owner-a' } },
  ])('keeps malformed known fields rejected on stored reads', (stored) => {
    expect(() => parseStoredModelPackPromotionIntentV1(stored, intent.packId)).toThrow('model_pack_promotion_intent_invalid');
  });
});
