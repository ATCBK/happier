import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';

/**
 * One selectable Agent or configured ACP backend projected by
 * `agents.backends.list`.
 *
 * Catalog Agent rows retain the stable contribution identity needed to select
 * the Agent without deriving it from presentation fields. Configured ACP rows
 * remain selectable through `backendId` and intentionally need not have one.
 */
export const AgentBackendInventoryItemSchema = lazyZodSchema(() => z.strictObject({
  targetKey: z.string().check(z.minLength(1)),
  label: z.string().check(z.minLength(1)),
  enabled: z.boolean(),
  agentId: z.optional(z.string().check(z.minLength(1))),
  identity: zMini.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
  backendId: z.optional(z.string().check(z.minLength(1))),
  description: z.optional(z.string().check(z.minLength(1))),
}));
export type AgentBackendInventoryItem = z.output<typeof AgentBackendInventoryItemSchema>;

export const AgentsBackendsListOutputSchema = lazyZodSchema(() => z.strictObject({
  items: z.array(AgentBackendInventoryItemSchema),
}));
export type AgentsBackendsListOutput = z.output<typeof AgentsBackendsListOutputSchema>;
