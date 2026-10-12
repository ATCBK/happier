import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineExecutionOriginV1Schema, getPluginMachineExecutionOriginRef } from '../machines/administration/pluginMachineExecutionOriginV1.js';

export const PLUGIN_EXECUTION_ORIGIN_ACTION_IDS = [
  'plugins.execution_origin.list', 'plugins.execution_origin.set', 'plugins.execution_origin.clear',
] as const;
export type PluginExecutionOriginActionId = typeof PLUGIN_EXECUTION_ORIGIN_ACTION_IDS[number];
export const PluginExecutionOriginActionIdSchema = lazyZodSchema(() => z.enum(PLUGIN_EXECUTION_ORIGIN_ACTION_IDS));
const contextualTarget = lazyZodSchema(() => z.object({ commandId: z.string().min(1) }).strict());
const base = lazyZodSchema(() => z.object({ pluginId: asProtocolZod(PluginIdSchema), contextualTarget: contextualTarget.optional() }).strict());
const version = lazyZodSchema(() => z.number().int().nonnegative());
const set = lazyZodSchema(() => base.extend({ origin: PluginMachineExecutionOriginV1Schema,
  expectedSettingsVersion: version.optional() }).strict().superRefine((input, ctx) => {
  if (!input.contextualTarget && input.expectedSettingsVersion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedSettingsVersion'], message: 'Account preferences require a settings version' });
  }
  if (getPluginMachineExecutionOriginRef(input.origin).pluginId !== input.pluginId) {
    ctx.addIssue({ code: 'custom', path: ['origin'], message: 'Origin must belong to the selected plugin' });
  }
}));
export const PluginExecutionOriginActionInputSchemas = {
  'plugins.execution_origin.list': lazyZodSchema(() => base.extend({ contextual: z.literal(true).optional() }).strict()),
  'plugins.execution_origin.set': set,
  'plugins.execution_origin.clear': lazyZodSchema(() => base.extend({ expectedSettingsVersion: version.optional() }).strict().superRefine((input, ctx) => {
    if (!input.contextualTarget && input.expectedSettingsVersion === undefined) {
      ctx.addIssue({ code: 'custom', path: ['expectedSettingsVersion'], message: 'Account preferences require a settings version' });
    }
  })),
} as const;

// All envelopes and nested authority-bearing references are closed. These
// Account writes retain their settings carrier. Contextual addresses name only
// the answering client's incumbent opaque mounted-command record.
const unavailable = lazyZodSchema(() => z.object({ status: z.literal('unavailable') }).strict());
const mutation = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('applied') }).strict(),
  z.object({ status: z.literal('applied'), settingsVersion: version }).strict(),
  z.object({ status: z.literal('conflict'), currentSettingsVersion: version }).strict(),
  z.object({ status: z.literal('outcomeUnknown'), lastKnownSettingsVersion: version,
    safeSnapshotVersion: version.optional() }).strict(), unavailable,
]));
const selection = lazyZodSchema(() => z.object({
  status: z.literal('available'),
  storedOrigin: PluginMachineExecutionOriginV1Schema.nullable(),
  selectedOrigin: PluginMachineExecutionOriginV1Schema.nullable(),
  candidates: z.array(z.object({ origin: PluginMachineExecutionOriginV1Schema,
    version: z.string().min(1), selectable: z.boolean() }).strict()),
}).strict());
export type PluginExecutionOriginContextualSelection = z.infer<typeof selection>;
export const PluginExecutionOriginActionOutputSchemas = {
  'plugins.execution_origin.list': lazyZodSchema(() => z.union([unavailable,
    selection.extend({ settingsVersion: version }).strict(), selection,
    z.object({ status: z.literal('available'), contextualTargets: z.array(z.object({ commandId: z.string().min(1),
      serverIdentityId: z.string().min(1), machineId: z.string().min(1) }).strict()) }).strict(),
  ])),
  'plugins.execution_origin.set': mutation,
  'plugins.execution_origin.clear': mutation,
} as const;
