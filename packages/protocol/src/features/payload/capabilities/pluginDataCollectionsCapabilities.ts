import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PLUGIN_COLLECTION_LIMITS_V1 } from '../../../plugins/data/collectionLimitsV1.js';

/**
 * Deployment ceilings advertised for diagnostic Collection preflight only.
 * The server mutation transaction remains the enforcement owner.
 */
export const PluginDataCollectionsCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  maxRowEncodedBytes: z.number().check(z.int(), z.positive(), z.maximum(PLUGIN_COLLECTION_LIMITS_V1.maximumStoredRowEncodedBytes)),
  maxBatchBytes: z.number().check(z.int(), z.positive(), z.maximum(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchEncodedBytes)),
  maxBatchRows: z.number().check(z.int(), z.positive(), z.maximum(PLUGIN_COLLECTION_LIMITS_V1.maximumMutationBatchRows)),
  maxAccountRows: z.number().check(z.int(), z.positive(), z.maximum(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountRows)),
  maxAccountBytes: z.number().check(z.int(), z.positive(), z.maximum(PLUGIN_COLLECTION_LIMITS_V1.maximumAccountEncodedBytes)),
}).check(z.superRefine((value, context) => {
  if (value.maxRowEncodedBytes > value.maxBatchBytes) {
    context.addIssue({
      code: "custom",
      path: ['maxRowEncodedBytes'],
      message: 'Collection row limit cannot exceed the batch byte limit.',
    });
  }
  if (value.maxBatchBytes > value.maxAccountBytes) {
    context.addIssue({
      code: "custom",
      path: ['maxBatchBytes'],
      message: 'Collection batch byte limit cannot exceed the Account byte limit.',
    });
  }
  if (value.maxBatchRows > value.maxAccountRows) {
    context.addIssue({
      code: "custom",
      path: ['maxBatchRows'],
      message: 'Collection batch row limit cannot exceed the Account row limit.',
    });
  }
})));

export type PluginDataCollectionsCapabilities = z.infer<
  typeof PluginDataCollectionsCapabilitiesSchema
>;
