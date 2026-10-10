import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { decodeBase64 } from '../../crypto/base64.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { PromptLibrarySaveOrganizationFieldsV1, isPromptLibrarySaveFolderAssignmentV1 } from './promptFolderActionSchemasV1.js';

const PromptBundleSchemaIdV1Schema = lazyZodSchema(() => z.enum(['skills.skill_md_v1', 'bundle.generic_v1']));
export type PromptBundleSchemaIdV1 = z.infer<typeof PromptBundleSchemaIdV1Schema>;
export { PromptBundleSchemaIdV1Schema };

export const PromptBundleArtifactHeaderV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), kind: z.literal('prompt_bundle.v2'), title: z.string().min(1),
  bundleSchemaId: PromptBundleSchemaIdV1Schema,
}).passthrough());

export const PromptBundleEntryV1Schema = lazyZodSchema(() => z
  .object({
    path: z.string().min(1),
    contentBase64: z.string().min(1),
    contentKind: z.enum(['utf8', 'binary']),
    unixMode: z.number().int().min(0).max(0o7777).nullable().optional(),
  })
  .passthrough());

export type PromptBundleEntryV1 = z.infer<typeof PromptBundleEntryV1Schema>;

// Mutation operands are closed even though stored bundle readers retain extensions.
const PromptBundleActionEntryV1Schema = lazyZodSchema(() => PromptBundleEntryV1Schema.strict());
const PromptBundleActionEntriesProjectionV1Schema = lazyZodSchema(() => z.array(createStoredReadSchema(PromptBundleActionEntryV1Schema)));

/** Retained annotations are read data, not operands of a current closed mutation. */
export function projectPromptBundleActionEntriesV1(entries: readonly PromptBundleEntryV1[]): PromptBundleCreateActionInputV1['entries'] {
  return PromptBundleActionEntriesProjectionV1Schema.parse(entries);
}
export const PromptBundleCreateActionInputV1Schema = lazyZodSchema(() => z.object({
  title: z.string().min(1), bundleSchemaId: PromptBundleSchemaIdV1Schema,
  entries: z.array(PromptBundleActionEntryV1Schema), ...PromptLibrarySaveOrganizationFieldsV1,
}).strict().refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' }));
export type PromptBundleCreateActionInputV1 = z.infer<typeof PromptBundleCreateActionInputV1Schema>;

const bundleUpdateFields = {
  artifactId: lazyZodSchema(() => z.string().min(1)), title: lazyZodSchema(() => z.string().min(1)),
  ...PromptLibrarySaveOrganizationFieldsV1,
} as const;
export const PromptBundleUpdateActionInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ...bundleUpdateFields, skillMarkdown: z.string(), expectedRevision: ArtifactRevisionV1Schema.optional() }).strict(),
  z.object({ ...bundleUpdateFields, entries: z.array(PromptBundleActionEntryV1Schema), expectedRevision: ArtifactRevisionV1Schema }).strict(),
]).refine(isPromptLibrarySaveFolderAssignmentV1, { message: 'Folder assignment must match the reviewed folder creation' }));
export type PromptBundleUpdateActionInputV1 = z.infer<typeof PromptBundleUpdateActionInputV1Schema>;

export const PromptBundleBodyV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    entries: z.array(PromptBundleEntryV1Schema),
    createdAtMs: z.number().int().min(0),
    updatedAtMs: z.number().int().min(0),
  })
  .passthrough());

export type PromptBundleBodyV1 = z.infer<typeof PromptBundleBodyV1Schema>;

/** Normalize an already-admitted retained body for current writes, preserving the raw read contract. */
export const PromptBundleBodyV1WriteSchema = createStoredReadSchema(PromptBundleBodyV1Schema);

export const PROMPT_BUNDLE_SCHEMA_LIMITS_V1 = Object.freeze({
  maxEntries: 128,
  maxTotalBytes: 1024 * 1024,
});

export type PromptBundleValidationResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      errorCode: 'unsupported_schema' | 'missing_required_entry' | 'invalid_request' | 'invalid_path' | 'duplicate_path' | 'size_limit_exceeded';
      message: string;
      path?: string;
      requiredPath?: string;
    }>;

function normalizePosixRelativePath(raw: string): { ok: true; normalized: string } | { ok: false; message: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, message: 'path is empty' };
  if (value.startsWith('/')) return { ok: false, message: 'path must be relative' };
  if (value.includes('\\')) return { ok: false, message: 'path must use posix separators' };
  if (value.includes('\u0000')) return { ok: false, message: 'path contains null byte' };

  const segments = value.split('/');
  if (segments.some((s) => s.length === 0)) return { ok: false, message: 'path contains empty segment' };
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, message: 'path contains dot segment' };
  }

  return { ok: true, normalized: segments.join('/') };
}

export function validatePromptBundleBodyV1AgainstSchemaId(input: Readonly<{
  bundleSchemaId: PromptBundleSchemaIdV1;
  body: PromptBundleBodyV1;
}>): PromptBundleValidationResult {
  const schemaId = input.bundleSchemaId;
  const body = input.body;

  const bodyParsed = PromptBundleBodyV1Schema.safeParse(body);
  if (!bodyParsed.success) {
    return { ok: false, errorCode: 'invalid_request', message: 'invalid_body' };
  }

  if (body.entries.length > PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxEntries) {
    return {
      ok: false,
      errorCode: 'size_limit_exceeded',
      message: `bundle exceeds max entry count of ${PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxEntries}`,
    };
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const entry of body.entries) {
    const normalized = normalizePosixRelativePath(entry.path);
    if (!normalized.ok) {
      return {
        ok: false,
        errorCode: 'invalid_path',
        message: normalized.message,
        path: entry.path,
      };
    }
    if (seen.has(normalized.normalized)) {
      return {
        ok: false,
        errorCode: 'duplicate_path',
        message: 'duplicate entry path',
        path: normalized.normalized,
      };
    }
    seen.add(normalized.normalized);

    totalBytes += decodeBase64(entry.contentBase64, 'base64').byteLength;
    if (totalBytes > PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxTotalBytes) {
      return {
        ok: false,
        errorCode: 'size_limit_exceeded',
        message: `bundle exceeds max total bytes of ${PROMPT_BUNDLE_SCHEMA_LIMITS_V1.maxTotalBytes}`,
        path: normalized.normalized,
      };
    }
  }

  if (schemaId === 'skills.skill_md_v1') {
    if (!seen.has('SKILL.md')) {
      return {
        ok: false,
        errorCode: 'missing_required_entry',
        message: 'skills bundles require SKILL.md at bundle root',
        requiredPath: 'SKILL.md',
      };
    }
  } else if (schemaId !== 'bundle.generic_v1') {
    return { ok: false, errorCode: 'unsupported_schema', message: `unsupported schema: ${schemaId}` };
  }

  return { ok: true };
}
