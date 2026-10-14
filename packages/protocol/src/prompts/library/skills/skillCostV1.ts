import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { estimateTokensV1 } from '../../../capabilities/estimateTokensV1.js';
import { readStoredSkillFrontmatterV1, splitSkillMarkdownV1 } from './skillLibraryItemV1.js';

export const SkillCostV1Schema = lazyZodSchema(() => z.object({ descriptionTokens: z.number().int().nonnegative(), bodyTokens: z.number().int().nonnegative() }).strict());
export type SkillCostV1 = z.infer<typeof SkillCostV1Schema>;
export function estimateSkillCostV1(skillMarkdown: string): SkillCostV1 {
  const { body } = splitSkillMarkdownV1(skillMarkdown);
  return { descriptionTokens: estimateTokensV1(readStoredSkillFrontmatterV1(skillMarkdown).description ?? ''), bodyTokens: estimateTokensV1(body) };
}
