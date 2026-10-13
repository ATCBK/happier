import { z } from 'zod';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { AgentIdV1Schema } from '../../../agents/agentIdV1.js';
import { SkillFileInputV1Schema } from './skillActionSchemasV1.js';
import { readCanonicalPaddedBase64DecodedLength } from '../../../crypto/base64.js';
import { validatePromptBundleBodyV1AgainstSchemaId } from '../promptBundleSchemas.js';

/** Found identifies the skill directory returned by the native-root scanner. */
export const FoundSkillDownloadRequestV1Schema = lazyZodSchema(() => z.object({ path: z.string().min(1) }).strict());
export type FoundSkillDownloadRequestV1 = z.infer<typeof FoundSkillDownloadRequestV1Schema>;

export const FoundSkillBundleV1Schema = lazyZodSchema(() => z.object({
  name: z.string().min(1), path: z.string().min(1), agents: z.array(AgentIdV1Schema),
  pluginOwned: z.object({ pluginName: z.string().min(1) }).strict().nullable(),
  files: z.array(SkillFileInputV1Schema.extend({ contentBase64: z.string().refine(value =>
    readCanonicalPaddedBase64DecodedLength(value) !== null, 'File bytes must be canonical base64') }).strict()),
}).strict().refine(payload => payload.files.some(file => file.path === 'SKILL.md' && file.contentKind === 'utf8')
  && validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'bundle.generic_v1',
    body: { v: 1, entries: payload.files, createdAtMs: 0, updatedAtMs: 0 } }).ok,
  'Found skill files require SKILL.md and safe relative paths'));
export type FoundSkillBundleV1 = z.infer<typeof FoundSkillBundleV1Schema>;
