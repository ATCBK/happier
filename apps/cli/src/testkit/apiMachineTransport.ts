import { vi } from 'vitest';

import type { ApiMachineClient } from '@/api/apiMachine';

/** Machine socket subscriptions and shutdown are the bootstrap transport boundary. */
export function createApiMachineTransportFixture() {
    return {
        onUpdate: vi.fn<ApiMachineClient['onUpdate']>(() => () => {}),
        onAccountSettingsVersionHint: vi.fn<ApiMachineClient['onAccountSettingsVersionHint']>(() => () => {}),
        onAccountProjectRowsChanged: vi.fn<ApiMachineClient['onAccountProjectRowsChanged']>(() => () => {}),
        onSessionFollowRulesChanged: vi.fn<ApiMachineClient['onSessionFollowRulesChanged']>(() => () => {}),
        onAutomationEventSourcesInvalidated: vi.fn<ApiMachineClient['onAutomationEventSourcesInvalidated']>(() => () => {}),
        onPendingSessionActivationHint: vi.fn<ApiMachineClient['onPendingSessionActivationHint']>(() => () => {}),
        onSessionDeletedChange: vi.fn<ApiMachineClient['onSessionDeletedChange']>(() => () => {}),
        onSessionChanged: vi.fn<ApiMachineClient['onSessionChanged']>(() => () => {}),
        onSessionAccessRevoked: vi.fn<ApiMachineClient['onSessionAccessRevoked']>(() => () => {}),
        onSessionAccessReset: vi.fn<ApiMachineClient['onSessionAccessReset']>(() => () => {}),
        onSessionTranscriptRevised: vi.fn<ApiMachineClient['onSessionTranscriptRevised']>(() => () => {}),
        onSessionArchivedStateChange: vi.fn<ApiMachineClient['onSessionArchivedStateChange']>(() => () => {}),
        onConnectionStateChange: vi.fn<ApiMachineClient['onConnectionStateChange']>(() => () => {}),
        onMachineTransferEnvelope: vi.fn<ApiMachineClient['onMachineTransferEnvelope']>(() => () => {}),
        onTransferRelayV2Envelope: vi.fn<ApiMachineClient['onTransferRelayV2Envelope']>(() => () => {}),
        onMachineLiveStreamRelayEnvelope: vi.fn<ApiMachineClient['onMachineLiveStreamRelayEnvelope']>(() => () => {}),
        onPeerTcpTunnelRelayEnvelope: vi.fn<ApiMachineClient['onPeerTcpTunnelRelayEnvelope']>(() => () => {}),
        shutdown: vi.fn<ApiMachineClient['shutdown']>(async () => {}),
    };
}
