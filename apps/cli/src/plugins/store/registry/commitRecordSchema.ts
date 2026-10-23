import { z } from 'zod/mini';
import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';

export function isRegistryObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPortableSegment(segment: string): boolean {
  return readPortablePathSegmentViolation(segment) === null;
}

export const PortableStorageIdSchema = z.string().check(z.minLength(1), z.maxLength(160), z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), z.refine(isPortableSegment, 'Expected a portable storage id'));
export const PortableRelativePathSchema = z.string().check(z.minLength(1), z.maxLength(512), z.superRefine((value, context) => {
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    context.addIssue({ code: 'custom', message: 'Expected a portable relative path' });
    return;
  }
  const segments = value.split('/');
  if (Buffer.byteLength(value, 'utf8') > 512 || segments.length > 64 || segments.some((segment) => !isPortableSegment(segment))) {
    context.addIssue({ code: 'custom', message: 'Expected a normalized portable relative path' });
  }
}));

export const PluginRegistryGenerationReferenceSchema = z.strictObject({ immutableGenerationId: PortableStorageIdSchema });
export type PluginRegistryGenerationReference = z.infer<typeof PluginRegistryGenerationReferenceSchema>;

/** One commit framing contract; execution additionally validates occurrence rows. */
export function createPluginRegistryCommitRecordSchema<T extends z.ZodMiniType<Record<string, PluginRegistryGenerationReference>>>(occurrences: T) {
  return z.strictObject({
    t: z.literal('happier_plugin_registry_commit_v1'),
    schemaVersion: z.literal(1),
    revision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    transactionId: PortableStorageIdSchema,
    baseRevision: z.nullable(z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER))),
    installationState: z.strictObject({ revisionId: PortableStorageIdSchema }),
    pluginOccurrenceIds: occurrences,
    createdAtMs: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
    creator: z.strictObject({
      pid: z.number().check(z.int(), z.positive(), z.maximum(0x7fffffff)),
      instanceId: PortableStorageIdSchema,
    }),
  }).check(z.superRefine((record, context) => {
    const expectedBase = record.revision === 0 ? null : record.revision - 1;
    if (record.baseRevision !== expectedBase) {
      context.addIssue({ code: 'custom', path: ['baseRevision'], message: `Revision ${record.revision} must name base revision ${String(expectedBase)}` });
    }
  }));
}
