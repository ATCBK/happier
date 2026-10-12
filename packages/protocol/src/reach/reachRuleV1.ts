import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ReachPlaceV1Schema } from './reachPlaceV1.js';

export const ReachRuleV1Schema = lazyZodSchema(() => z.object({
  id: z.string().min(1), target: ReachPlaceV1Schema, agentId: z.string().min(1).optional(),
  enabled: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
}).strict());
export type ReachRuleV1 = z.infer<typeof ReachRuleV1Schema>;
export type ReachRulesV1 = readonly ReachRuleV1[];
export const ReachRuleDraftV1Schema = lazyZodSchema(() => ReachRuleV1Schema.pick({ target: true, agentId: true, enabled: true }));
export type ReachRuleDraftV1 = Readonly<z.infer<typeof ReachRuleDraftV1Schema>>;
export const SkillRuleV1Schema = lazyZodSchema(() => ReachRuleV1Schema.extend({ skillId: z.string().min(1) }).strict());
export type SkillRuleV1 = z.infer<typeof SkillRuleV1Schema>;
