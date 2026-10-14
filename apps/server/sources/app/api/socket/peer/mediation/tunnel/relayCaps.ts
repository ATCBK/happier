import { MachineTunnelServerRoutedCapabilitiesSchema, normalizeMachineTunnelAllowedPorts, normalizeMachineTunnelPreferredEncoding, type MachineTunnelServerRoutedCapabilities } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { type PeerTcpTunnelEncoding } from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';

export type PeerTcpTunnelRelayCaps = Readonly<Omit<MachineTunnelServerRoutedCapabilities, 'disabledReason' | 'supportedEncodings'> & {
    serverRoutedEnabled: boolean;
    supportedEncodings: readonly PeerTcpTunnelEncoding[];
    allowedPorts: readonly number[];
}>;

export function resolvePeerTcpTunnelRelayCaps(input: Partial<PeerTcpTunnelRelayCaps>): PeerTcpTunnelRelayCaps {
    const { disabledReason: _disabledReason, ...resources } = MachineTunnelServerRoutedCapabilitiesSchema.parse(input);
    return {
        ...resources,
        serverRoutedEnabled: input.serverRoutedEnabled === true,
        preferredEncoding: normalizeMachineTunnelPreferredEncoding(input.preferredEncoding, resources.supportedEncodings),
        allowedPorts: normalizeMachineTunnelAllowedPorts(input.allowedPorts),
    };
}
