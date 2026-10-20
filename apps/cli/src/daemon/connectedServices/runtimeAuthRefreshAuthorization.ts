import { z } from 'zod/mini';
import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';
import { ConnectedServiceAuthGroupIdSchema, ConnectedServiceProfileIdSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from '@happier-dev/protocol/connect/connected-service-bindings';

import type { ConnectedServiceRuntimeTarget } from './runtimeRegistry/registry';

export const ConnectedServiceRuntimeAuthRefreshServiceIdSchema = z.pipe(z.string().check(z.trim(), z.minLength(1)), z.transform((value, ctx) => {
  const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(value);
  if (serviceId) return serviceId;
  ctx.issues.push({ code: "custom", message: 'Invalid connected service identity', input: ctx.value });
  return z.NEVER;
}));

export const ConnectedServiceRuntimeAuthRefreshSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile'), serviceId: ConnectedServiceRuntimeAuthRefreshServiceIdSchema,
    profileId: ConnectedServiceProfileIdSchema }),
  z.strictObject({ kind: z.literal('group'), serviceId: ConnectedServiceRuntimeAuthRefreshServiceIdSchema,
    groupId: ConnectedServiceAuthGroupIdSchema, activeProfileId: ConnectedServiceProfileIdSchema,
    fallbackProfileId: ConnectedServiceProfileIdSchema, generation: z.number().check(z.int(), z.nonnegative()) }),
]);

export type ConnectedServiceRuntimeAuthRefreshSelection = Readonly<
  | {
      kind: 'profile';
      serviceId: ConnectedAccountServiceKey;
      profileId: string;
    }
  | {
      kind: 'group';
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
    }
>;

/**
 * Whether a live runtime-registry target owns the requested session runtime-auth selection.
 */
export function runtimeTargetOwnsConnectedServiceRuntimeAuthRefreshSelection(input: Readonly<{
  target: ConnectedServiceRuntimeTarget;
  selection: ConnectedServiceRuntimeAuthRefreshSelection;
}>): boolean {
  if (input.selection.kind === 'profile') {
    const requested = input.selection;
    return input.target.boundProfiles.some((bound) => (
      bound.serviceId === requested.serviceId
      && bound.profileId === requested.profileId
    ));
  }
  const requested = input.selection;
  const envSelection = input.target.connectedServiceSelections
    .find((selection) => selection.serviceId === requested.serviceId) ?? null;
  return envSelection?.kind === 'group'
    && envSelection.groupId === requested.groupId
    && envSelection.activeProfileId === requested.activeProfileId
    && envSelection.fallbackProfileId === requested.fallbackProfileId
    && envSelection.generation === requested.generation;
}
