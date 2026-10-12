import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';

export const SkillReadInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ skillId: z.string().min(1), sessionId: z.string().min(1).optional(), file: z.string().min(1).optional() }).strict(),
  z.object({ name: z.string().min(1), sessionId: z.string().min(1), file: z.string().min(1).optional() }).strict(),
]));
export type SkillReadInputV1 = z.infer<typeof SkillReadInputV1Schema>;

export const SkillReadResultV1Schema = lazyZodSchema(() => z.object({
  skillId: z.string().min(1), name: z.string().min(1), skillMd: z.string(),
  files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().min(0),
    unixMode: z.number().int().min(0).max(0o7777).optional() }).strict()),
  file: z.object({ path: z.string().min(1), contentBase64: z.string(), contentKind: z.enum(['utf8', 'binary']),
    unixMode: z.number().int().min(0).max(0o7777).optional() }).strict().optional(),
}).strict());
export type SkillReadResultV1 = z.infer<typeof SkillReadResultV1Schema>;
export type SessionSkillReadItemV1 = Readonly<{ skillId: string; name: string; digest: string }>;
