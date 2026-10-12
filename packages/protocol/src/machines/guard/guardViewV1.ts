import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineGuardActivityWayBackV1Schema } from './activityV1.js';

export const GuardKeepReasonV1Schema = z.enum(['working', 'waiting_for_you', 'subagents_running', 'unsent_draft',
  'draft_unknown', 'not_resumable', 'kill_protected', 'activity_unknown', 'kept_running', 'identity_changed',
  'ownership_unknown', 'not_happier', 'footprint_unknown', 'browser_in_use', 'connections_unknown', 'visitors', 'unsupported_target', 'stop_failed']);
export type GuardKeepReasonV1 = z.infer<typeof GuardKeepReasonV1Schema>;
// These closed requester-filtered projections contain no executable process authority.
export const MachineGuardLadderCandidateV1Schema = lazyZodSchema(() => z.object({
  ref: z.string().min(1),
  /** The census process identity (pid + birth), the same ref the Processes census and stop Actions use. */
  processRef: z.string().min(1).optional(),
  kind: z.enum(['browser', 'service', 'session']), label: z.string(), qualifier: z.string(),
  footprintBytes: z.number().finite().nonnegative(), wayBack: z.array(MachineGuardActivityWayBackV1Schema).optional(),
}).strict());
export const MachineGuardLadderV1Schema = lazyZodSchema(() => z.object({
  steps: z.array(z.object({ rung: z.enum(['browsers', 'devServers', 'idleSessions']), enabled: z.boolean(),
    status: z.enum(['next', 'skip', 'off', 'run', 'done']), freesAboutBytes: z.number().finite().nonnegative(),
    candidates: z.array(MachineGuardLadderCandidateV1Schema),
  }).strict()),
  excluded: z.array(z.object({ ref: z.string().min(1), processRef: z.string().min(1).optional(), kind: z.enum(['browser', 'service', 'session']),
    label: z.string(), reason: GuardKeepReasonV1Schema, footprintBytes: z.number().finite().nonnegative().nullable(),
  }).strict()),
  summary: z.object({ candidatesBytes: z.number().finite().nonnegative(), inUseBytes: z.number().finite().nonnegative(),
    workingBytes: z.number().finite().nonnegative(), workingSessions: z.number().int().nonnegative(),
    notHappiersBytes: z.number().finite().nonnegative(), leftAloneSessions: z.number().int().nonnegative(),
  }).strict(),
}).strict());
export type MachineGuardLadderV1 = z.infer<typeof MachineGuardLadderV1Schema>;
