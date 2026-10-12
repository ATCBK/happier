import { z } from 'zod';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DevelopmentPluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';

/** Canonical closed binding; persisted readers derive their drop projection. */
export const VoiceModelPackArtifactBindingV1Schema = lazyZodSchema(() => z.union([
  z.object({
    kind: z.literal('sourceIntegrity'),
    integrity: z.string().min(1).max(1024).refine((value) => value.trim() === value),
  }).strict(),
  z.object({
    kind: z.literal('materialization'),
    sourceCustody: DevelopmentPluginSourceCustodyV1Schema,
  }).strict(),
]));

export type VoiceModelPackArtifactBindingV1 = z.infer<typeof VoiceModelPackArtifactBindingV1Schema>;
