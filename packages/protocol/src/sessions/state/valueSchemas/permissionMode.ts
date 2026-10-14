import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionPermissionModeSchema } from '../../metadata/sessionPermissionModes.js';

export const SessionStatePermissionModeValueSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    permissionMode: SessionPermissionModeSchema,
    updatedAt: z.number(),
  }));
