import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';

import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { PluginSourceSpecV1Schema } from '@happier-dev/protocol/plugins/source-spec';
import { PluginUpdatePolicyV1Schema } from '@happier-dev/protocol/marketplace/pluginUpdatePolicyV1';

import { PluginCompatibilityDiagnosticSchema } from '@/plugins/validation/diagnostics/types';
import {
  createDefaultPluginAccessScopeRegistry,
  PluginAccessSelectionSchema,
} from './install/accessScopeRegistry';
import { PluginTrustRecordSchema } from './install/trustIdentity';

export const PluginCompatibilityStatusSchema = z.enum(['unknown', 'compatible', 'incompatible', 'load_error']);
export type PluginCompatibilityStatus = z.infer<typeof PluginCompatibilityStatusSchema>;

export const PluginInstallModeSchema = z.enum(['link', 'managed_install']);
export type PluginInstallMode = z.infer<typeof PluginInstallModeSchema>;

export const PluginStateSourceRecordSchema = (<T extends z.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(zMini.safeExtend(PluginSourceSpecV1Schema, {
  resolvedPath: z.string().check(z.minLength(1)),
  manifestPath: z.string().check(z.minLength(1)),
  devWatch: z.optional(z.boolean()),
}));
export type PluginStateSourceRecord = z.infer<typeof PluginStateSourceRecordSchema>;

export const PluginStateCompatibilityRecordSchema = z.strictObject({
  status: PluginCompatibilityStatusSchema,
  checkedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  diagnostics: z._default(z.array(PluginCompatibilityDiagnosticSchema), []),
});
export type PluginStateCompatibilityRecord = z.infer<typeof PluginStateCompatibilityRecordSchema>;

export const PluginStateInstallRecordSchema = z.strictObject({
  mode: PluginInstallModeSchema,
  manifestVersion: z.string().check(z.minLength(1)),
  installedPath: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  trust: z.optional(PluginTrustRecordSchema),
  updatePolicy: z.optional(PluginUpdatePolicyV1Schema),
  optionalAccess: z.optional(z.array(PluginAccessSelectionSchema)),
});
export type PluginStateInstallRecord = z.infer<typeof PluginStateInstallRecordSchema>;

export const PluginStateLifecycleRecordSchema = z.strictObject({
  enabled: z.boolean(),
  lastLoadedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  lastError: z.optional(z.nullable(z.string().check(z.minLength(1)))),
});
export type PluginStateLifecycleRecord = z.infer<typeof PluginStateLifecycleRecordSchema>;

export const PluginStateRecordSchema = z.strictObject({
  source: PluginStateSourceRecordSchema,
  compatibility: PluginStateCompatibilityRecordSchema,
  install: PluginStateInstallRecordSchema,
  state: PluginStateLifecycleRecordSchema,
});
export type PluginStateRecord = z.infer<typeof PluginStateRecordSchema>;

const PluginStateFileV1BaseSchema = z.strictObject({
  t: z.literal('happier_plugin_state_v1'),
  schemaVersion: z.literal(1),
  plugins: z.record(z.string().check(z.superRefine((value, context) => {
    const parsed = PluginIdSchema.safeParse(value);
    if (!parsed.success || parsed.data !== value) {
      context.addIssue({ code: 'custom', message: 'Expected a canonical plugin id' });
    }
  })), PluginStateRecordSchema),
});

const pluginAccessScopeRegistry = createDefaultPluginAccessScopeRegistry();

export const PluginStateFileV1Schema = PluginStateFileV1BaseSchema.check(z.superRefine((state, context) => {
  for (const [pluginId, record] of Object.entries(state.plugins)) {
    if (record.install.trust && record.install.trust.pluginId !== pluginId) {
      context.addIssue({
        code: 'custom',
        path: ['plugins', pluginId, 'install', 'trust', 'pluginId'],
        message: 'Plugin trust identity must match its installed-state plugin id',
      });
    }
    const accessIds = new Set<string>();
    for (const [index, selection] of (record.install.optionalAccess ?? []).entries()) {
      if (selection.pluginId !== pluginId || !pluginAccessScopeRegistry.validateSelection(selection)) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', pluginId, 'install', 'optionalAccess', index],
          message: 'Invalid canonical plugin optional access selection',
        });
      }
      if (accessIds.has(selection.accessId)) {
        context.addIssue({
          code: 'custom',
          path: ['plugins', pluginId, 'install', 'optionalAccess', index, 'accessId'],
          message: 'Duplicate plugin optional access selection id',
        });
      }
      accessIds.add(selection.accessId);
    }
  }
}));
export type PluginStateFileV1 = z.infer<typeof PluginStateFileV1Schema>;

export { resolvePluginStorePaths } from './paths';
