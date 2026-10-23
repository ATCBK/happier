import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { ResolveSharedManagedProviderGatewayBinding } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

/** One Home/Account/Machine identity owner for all managed Provider consumers. */
export function createMachineSharedProviderGatewayResolver(input: Readonly<{
  machineId: string;
  readAccountId(): string | null;
  readOrigin(): Promise<CurrentMachineExecutionOriginContext | null>;
}>): ResolveSharedManagedProviderGatewayBinding {
  const readIdentity: NonNullable<ResolveSharedManagedProviderGatewayBinding['readIdentity']> = async ({ connectionId, signal }) => {
    signal?.throwIfAborted();
    const origin = await input.readOrigin();
    signal?.throwIfAborted();
    const accountId = input.readAccountId()?.trim() || null;
    const homeId = origin?.serverIdentityId?.trim() || null;
    if (!homeId || !accountId || origin?.machineId !== input.machineId) {
      throw createProviderErrorV1('provider_authorization_changed', { connectionId, machineId: input.machineId });
    }
    return Object.freeze({ homeId, accountId, connectionId, machineId: input.machineId });
  };
  const resolve: ResolveSharedManagedProviderGatewayBinding = async ({ consumerId, ...request }) =>
    Object.freeze({ ...await readIdentity(request), consumerId });
  return Object.assign(resolve, { readIdentity });
}
