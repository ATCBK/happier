import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ModelPackPromotionIntentV1Schema } from '@happier-dev/protocol/voice/modelPacks/promotionIntentV1';

export type ModelPackPromotionPriorInstallV1 = Readonly<{
  scopeKey: string;
  identityKey: string;
}> | null;

export type ModelPackDurableRecoveryRecord = Readonly<{
  kind: string;
  value: unknown;
}>;

export const MODEL_PACK_PROMOTION_INTENT_MAX_BYTES = 64 * 1024;

export type ModelPackPromotionIntentV1 = Readonly<{
  schemaVersion: 1;
  packId: string;
  phase: 'swap_prepared' | 'metadata_pending' | 'metadata_committed' | 'rollback_pending';
  startedAtMs: number;
  token: string;
  priorInstall: ModelPackPromotionPriorInstallV1;
  recovery: ModelPackDurableRecoveryRecord | null;
}>;

const StoredModelPackPromotionIntentV1Schema = createStoredReadSchema(ModelPackPromotionIntentV1Schema);

function invalidIntent(): never {
  throw new Error('model_pack_promotion_intent_invalid');
}

export function parseModelPackPromotionIntentV1(
  raw: unknown,
  expectedPackId: string,
): ModelPackPromotionIntentV1 {
  const parsed = ModelPackPromotionIntentV1Schema.safeParse(raw);
  if (!parsed.success || parsed.data.packId !== expectedPackId) invalidIntent();
  return freezeIntent(parsed.data);
}

export function parseStoredModelPackPromotionIntentV1(
  raw: unknown,
  expectedPackId: string,
): ModelPackPromotionIntentV1 {
  const parsed = StoredModelPackPromotionIntentV1Schema.safeParse(raw);
  if (!parsed.success || parsed.data.packId !== expectedPackId) invalidIntent();
  return freezeIntent(parsed.data);
}

function freezeIntent(value: ModelPackPromotionIntentV1): ModelPackPromotionIntentV1 {
  return Object.freeze({
    ...value,
    priorInstall: value.priorInstall === null
      ? null
      : Object.freeze({ ...value.priorInstall }),
    recovery: value.recovery === null
      ? null
      : Object.freeze({ ...value.recovery }),
  });
}

export function isLegacyModelPackPromotionIntent(
  raw: unknown,
  expectedPackId: string,
): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Readonly<Record<string, unknown>>;
  if (
    Object.prototype.hasOwnProperty.call(value, 'schemaVersion')
    || Object.prototype.hasOwnProperty.call(value, 'phase')
    || Object.prototype.hasOwnProperty.call(value, 'priorInstall')
    || Object.prototype.hasOwnProperty.call(value, 'recovery')
  ) return false;
  return value.packId === undefined || value.packId === expectedPackId;
}
