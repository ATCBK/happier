import type { DaemonProviderModelProjectionGroupV1 } from '@happier-dev/protocol/rpc';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';

/**
 * How a provider connection is named next to one of its models: the provider alone for its
 * automatically named default connection (or a connection named after its provider), otherwise
 * "Provider · Connection".
 */
export function providerModelConnectionTitle(group: Pick<
    DaemonProviderModelProjectionGroupV1,
    'providerName' | 'connectionName' | 'connectionRole' | 'connectionDisplayNameMode'
>): string {
    const identity = presentProviderConnectionIdentity({ providerName: group.providerName, displayName: group.connectionName,
        role: group.connectionRole, displayNameMode: group.connectionDisplayNameMode });
    return identity.sourceLabel;
}
