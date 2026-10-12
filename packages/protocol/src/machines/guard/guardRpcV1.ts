import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineGuardPolicyV1Schema } from './guardPolicyV1.js';
import { MachineGuardStateV1Schema } from './guardStateV1.js';
import { GuardKeepReasonV1Schema, MachineGuardLadderV1Schema } from './guardViewV1.js';
import { MachineGuardActivityRowV1Schema } from './activityV1.js';

const count = () => z.number().int().nonnegative();
const bytes = () => z.number().finite().nonnegative();
export const MachineGuardViewV1Schema = lazyZodSchema(() => z.object({
  policy: MachineGuardPolicyV1Schema, policyRevision: count(), state: MachineGuardStateV1Schema,
  ladder: MachineGuardLadderV1Schema,
  othersWorkCount: count(),
  idle: z.array(z.object({ sessionRef: z.string().min(1), title: z.string(), agentId: z.string(),
    status: z.enum(['stops_at', 'kept', 'not_yet']), stopAt: bytes().optional(), reason: GuardKeepReasonV1Schema.optional(), idleMs: bytes(),
  }).strict()),
  idleTerminals: z.array(z.object({ terminalId: z.string().min(1), terminalKey: z.string().min(1), label: z.string(),
    idleMs: bytes(), eligible: z.boolean(), commandRunning: z.boolean().nullable(),
    status: z.enum(['eligible', 'stops_at', 'not_yet']), stopAt: bytes().optional(),
    reasons: z.array(z.enum(['foreground_unknown', 'finite_work', 'stop_pending', 'native_owner_unknown', 'not_yet', 'warning_unavailable', 'wrong_target'])),
  }).strict()).optional(),
  leftBehind: z.object({ count: count(), footprintBytes: bytes().nullable() }).strict(),
  keepAwake: z.object({ holding: z.boolean(), workingSessions: count() }).strict(),
  managed: z.object({ retentionRef: z.string().min(1) }).strict().optional(),
  recentActivity: z.array(MachineGuardActivityRowV1Schema),
  recentActivityOthers: count(),
  // GRD-25: evaluated once at get/watch admission, never on each parked answer.
  otherMemoryGuards: z.array(z.enum(['systemd-oomd', 'earlyoom'])).optional(),
}).strict());
export type MachineGuardViewV1 = z.infer<typeof MachineGuardViewV1Schema>;
export const MachineGuardGetInputV1Schema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1), serverId: z.string().trim().min(1).optional(),
}).strict());
export const MachineGuardWatchInputV1Schema = lazyZodSchema(() => MachineGuardGetInputV1Schema.extend({ since: count().optional() }).strict());
export type MachineGuardWatchInputV1 = z.infer<typeof MachineGuardWatchInputV1Schema>;
export const MachineGuardWatchResultV1Schema = lazyZodSchema(() => z.union([
  z.object({ changed: z.literal(true), view: MachineGuardViewV1Schema, since: count() }).strict(),
  z.object({ changed: z.literal(false) }).strict(),
]));
export type MachineGuardWatchResultV1 = z.infer<typeof MachineGuardWatchResultV1Schema>;
