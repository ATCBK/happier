import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const ProviderHttpsUrlSchema = lazyZodSchema(() => z.url().check(z.refine((value) => new URL(value).protocol === 'https:', 'Provider user-openable links must use HTTPS')));
