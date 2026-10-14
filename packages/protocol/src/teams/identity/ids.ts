import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from "zod/mini";

/** Immutable Team identity-connection identifier shared by policy and connection contracts. */
export const TeamIdentityConnectionIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(512)));
