import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineExecutionOriginV1Schema, getPluginMachineExecutionOriginRef } from '../machines/administration/pluginMachineExecutionOriginV1.js';

export const PLUGIN_EXECUTION_ORIGIN_ACTION_IDS = [
  'plugins.execution_origin.list', 'plugins.execution_origin.set', 'plugins.execution_origin.clear',
] as const;
export type PluginExecutionOriginActionId = typeof PLUGIN_EXECUTION_ORIGIN_ACTION_IDS[number];
export const PluginExecutionOriginActionIdSchema = lazyZodSchema(() => z.enum(PLUGIN_EXECUTION_ORIGIN_ACTION_IDS));
const contextualTarget = lazyZodSchema(() => z.strictObject({ commandId: z.string().check(z.minLength(1)) }));
const base = lazyZodSchema(() => z.strictObject({ pluginId: asProtocolZod(PluginIdSchema), contextualTarget: z.optional(contextualTarget) }));
const version = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const set = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, { origin: PluginMachineExecutionOriginV1Schema,
  expectedSettingsVersion: z.optional(version) })).check(z.superRefine((input, ctx) => {
  if (!input.contextualTarget && input.expectedSettingsVersion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedSettingsVersion'], message: 'Account preferences require a settings version' });
  }
  if (getPluginMachineExecutionOriginRef(input.origin).pluginId !== input.pluginId) {
    ctx.addIssue({ code: 'custom', path: ['origin'], message: 'Origin must belong to the selected plugin' });
  }
})));
export const PluginExecutionOriginActionInputSchemas = {
  'plugins.execution_origin.list': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, { contextual: z.optional(z.literal(true)) }))),
  'plugins.execution_origin.set': set,
  'plugins.execution_origin.clear': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, { expectedSettingsVersion: z.optional(version) })).check(z.superRefine((input, ctx) => {
    if (!input.contextualTarget && input.expectedSettingsVersion === undefined) {
      ctx.addIssue({ code: 'custom', path: ['expectedSettingsVersion'], message: 'Account preferences require a settings version' });
    }
  }))),
} as const;

// All envelopes and nested authority-bearing references are closed. These
// Account writes retain their settings carrier. Contextual addresses name only
// the answering client's incumbent opaque mounted-command record.
const unavailable = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable') }));
const mutation = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('applied') }),
  z.strictObject({ status: z.literal('applied'), settingsVersion: version }),
  z.strictObject({ status: z.literal('conflict'), currentSettingsVersion: version }),
  z.strictObject({ status: z.literal('outcomeUnknown'), lastKnownSettingsVersion: version,
    safeSnapshotVersion: z.optional(version) }), unavailable,
]));
const selection = lazyZodSchema(() => z.strictObject({
  status: z.literal('available'),
  storedOrigin: z.nullable(PluginMachineExecutionOriginV1Schema),
  selectedOrigin: z.nullable(PluginMachineExecutionOriginV1Schema),
  candidates: z.array(z.strictObject({ origin: PluginMachineExecutionOriginV1Schema,
    version: z.string().check(z.minLength(1)), selectable: z.boolean() })),
}));
export type PluginExecutionOriginContextualSelection = z.infer<typeof selection>;
export const PluginExecutionOriginActionOutputSchemas = {
  'plugins.execution_origin.list': lazyZodSchema(() => z.union([unavailable,
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(selection, { settingsVersion: version })), selection,
    z.strictObject({ status: z.literal('available'), contextualTargets: z.array(z.strictObject({ commandId: z.string().check(z.minLength(1)),
      serverIdentityId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)) })) }),
  ])),
  'plugins.execution_origin.set': mutation,
  'plugins.execution_origin.clear': mutation,
} as const;
