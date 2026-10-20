/**
 * Native Iroh module surface. Lifecycle/status only — tunnel payload bytes
 * never cross this boundary.
 *
 * One handle-based lifecycle owns the persistent application endpoint and
 * every Home tunnel lease. Tunnel bytes never cross this boundary.
 */
export {
  MACHINE_HTTP_LOCAL_CAPABILITY_HEADER as IROH_MACHINE_HTTP_LOCAL_CAPABILITY_HEADER,
  MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX as IROH_MACHINE_WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX,
} from './descriptor.js';

export type NativeIrohModule = Readonly<{
  getAvailability?: () => Record<string, unknown>;
  createEndpoint: (request: {
    keyPath?: string;
    relayPolicy?: 'automatic' | 'disabled';
    relayUrls?: readonly string[];
    capProfile?: 'homeInteractive' | 'machineBulk';
  }) => Promise<{
    endpointHandle: string;
    endpointId: string;
    relayPolicy: 'automatic' | 'disabled';
    relayMode: 'disabled' | 'custom';
    capProfile: string;
    relayUrls: readonly string[];
  }>;
  startHomeAcceptor?: (request: {
    endpointHandle: string;
    targetHost?: string;
    targetPort: number;
  }) => Promise<{
    endpointHandle: string;
    reused: boolean;
    status: Record<string, unknown>;
  }>;
  stopHomeAcceptor?: (request: { endpointHandle: string }) => Promise<void>;
  ensureHomeTunnel: (request: {
    endpointHandle: string;
    homeServerIdentityId: string;
    endpointId: string;
    directAddresses?: readonly string[];
    relayUrls?: readonly string[];
  }) => Promise<{
    tunnelId: string;
    homeServerIdentityId: string;
    homeEndpointId: string;
    runtimeOrigin: string;
    carrier: 'iroh';
    observedPath: 'direct' | 'relay' | 'unknown';
    startedAtMs: number;
    endpointHandle: string;
  }>;
  releaseHomeTunnel: (tunnelId: string) => Promise<void>;
  shutdownEndpoint: (request: { endpointHandle: string }) => Promise<void>;
  getEndpointStatus?: (endpointHandle: string) => Promise<Record<string, unknown> | null>;
  getTunnelStatus: (tunnelId: string) => Promise<Record<string, unknown> | null>;
  startMachineTunnel?: (request: {
    endpointHandle: string;
    endpointId: string;
    directAddresses?: readonly string[];
    relayUrls?: readonly string[];
    handshakeJson: string;
    capProfile?: 'machineBulk';
    /** Guest-safe HTTP/WS origin over one signed generic TCP mux destination. */
    nativeHttpLease?: { openJson: string };
  }) => Promise<{
    machineTunnelId: string;
    endpointHandle: string;
    localPort: number;
    localCapability?: string;
    connectionActive: boolean;
    remoteEndpointId: string;
    observedPath: 'direct' | 'relay' | 'unknown';
    startedAtMs: number;
    lastErrorCode: string | null;
  }>;
  startMachineHttpTunnel?: (request: {
    endpointHandle: string;
    endpointId: string;
    directAddresses?: readonly string[];
    relayUrls?: readonly string[];
    handshakeJson: string;
    capProfile?: 'machineBulk';
  }) => Promise<{
    machineTunnelId: string;
    endpointHandle: string;
    localPort: number;
    localCapability: string;
    connectionActive: boolean;
    remoteEndpointId: string;
    observedPath: 'direct' | 'relay' | 'unknown';
    startedAtMs: number;
    lastErrorCode: string | null;
  }>;
  stopMachineTunnel?: (machineTunnelId: string) => Promise<void>;
  /** Settles when the guest mux/listener finishes, including explicit stop. */
  waitMachineTunnelClosed?: (machineTunnelId: string) => Promise<void>;
}>;
