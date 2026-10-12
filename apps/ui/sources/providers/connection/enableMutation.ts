import type { ProviderConnectionActionInputV1 } from '@/providers/actions/client';

/** Connection-wide disable clears all grants; enabling explicitly admits Account access. */
export function buildProviderConnectionEnableMutation(input: Readonly<{
    connectionId: string;
    enabled: boolean;
}> & (Readonly<{ access: 'connection' | 'account' }> | Readonly<{ access: 'machine'; machineId: string }>)):
    Extract<ProviderConnectionActionInputV1, { action: 'setEnabled' }> {
    return {
        action: 'setEnabled', connectionId: input.connectionId, enabled: input.enabled,
        scope: input.access === 'connection' && input.enabled ? 'account' : input.access,
        ...(input.access === 'machine' && input.machineId ? { machineId: input.machineId } : {}),
    };
}
