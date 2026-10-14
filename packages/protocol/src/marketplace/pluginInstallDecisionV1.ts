import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const HOST_PRIVATE_PLUGIN_INSTALL_DECISION_RPC_METHOD = 'daemon.plugins.install.review.decide' as const;

export const HostPrivatePluginInstallOptionalSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  accessId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  selected: z.boolean(),
}));

/**
 * A decision names the daemon-issued pending change it answers and nothing
 * about its own author. The daemon authenticates this RPC and resolves the
 * pending change itself, so a caller-supplied actor, interaction id, or
 * timestamp would be self-asserted rather than evidence; approval and
 * selection times come from the daemon clock at apply time.
 */
const HostPrivatePluginInstallPositiveDecisionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  pendingChangeId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  decision: z.literal('installAndTrust'),
  optionalSelections: z.array(HostPrivatePluginInstallOptionalSelectionV1Schema).check(z.maxLength(128)),
}).check(z.superRefine((value, context) => {
  const accessIds = new Set<string>();
  for (const selection of value.optionalSelections) {
    if (accessIds.has(selection.accessId)) {
      context.addIssue({
        code: 'custom',
        message: 'optionalSelections must contain unique accessId values',
        path: ['optionalSelections'],
      });
      return;
    }
    accessIds.add(selection.accessId);
  }
})));

const HostPrivatePluginInstallCancelDecisionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  pendingChangeId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  decision: z.literal('cancel'),
}));

export const HostPrivatePluginInstallDecisionV1Schema = lazyZodSchema(() => z.union([
  HostPrivatePluginInstallPositiveDecisionV1Schema,
  HostPrivatePluginInstallCancelDecisionV1Schema,
]));

export type HostPrivatePluginInstallDecisionV1 = z.infer<typeof HostPrivatePluginInstallDecisionV1Schema>;
