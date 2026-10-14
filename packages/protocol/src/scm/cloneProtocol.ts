import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const SourceControlCloneProtocolSchema = lazyZodSchema(() => z.enum(['auto', 'ssh', 'https']));
export type SourceControlCloneProtocol =
  z.infer<typeof SourceControlCloneProtocolSchema>;
