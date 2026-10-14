import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const SessionStateTitleValueSchema = lazyZodSchema(() => z.string());
