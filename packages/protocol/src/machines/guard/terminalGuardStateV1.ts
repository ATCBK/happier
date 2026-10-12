import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** PTY-owner presentation only; clearing the warning removes this field. */
export const TerminalGuardStateV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), kind: z.literal('stopping'), rule: z.literal('idle_terminals'),
  stopAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict());
export type TerminalGuardStateV1 = z.infer<typeof TerminalGuardStateV1Schema>;
