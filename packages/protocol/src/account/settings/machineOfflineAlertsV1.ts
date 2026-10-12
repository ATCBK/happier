import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Account-owned explicit enrollment; empty means no machine offline alerts. */
export const MachineOfflineAlertsV1Schema = lazyZodSchema(() => z.object({
  machineIds: z.array(z.string().trim().min(1)),
}).strict());
export type MachineOfflineAlertsV1 = z.infer<typeof MachineOfflineAlertsV1Schema>;
export const DEFAULT_MACHINE_OFFLINE_ALERTS_V1: MachineOfflineAlertsV1 = { machineIds: [] };
