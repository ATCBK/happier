import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { SecretReferenceOverlayV1Schema } from '../../profiles/secretReferenceOverlayV1.js';

/** Setup is revisioned with a preset. Only the exact Saved Secret owner resolves values. */
export const MachineEnvironmentV1Schema = lazyZodSchema(() => z.strictObject({
  toolchain: z.optional(z.strictObject({ adapterId: z.string().check(z.trim(), z.minLength(1)), config: z.string() })),
  setupScript: z.optional(z.string()),
  secretRefs: z.optional(SecretReferenceOverlayV1Schema),
}));
export const MachineEnvironmentV1ReadSchema = createStoredReadSchema(MachineEnvironmentV1Schema);
export type MachineEnvironmentV1 = Readonly<z.infer<typeof MachineEnvironmentV1Schema>>;
