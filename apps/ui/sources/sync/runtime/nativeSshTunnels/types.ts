import type { NativeSshTunnelPurpose, NativeSshTunnelLease, NativeSshTunnelSnapshot } from '@happier-dev/protocol/ssh/tunnels';
export type { NativeSshTunnelPurpose, NativeSshTunnelStatus, NativeSshTunnelLease,
    NativeSshTunnelLimitation, NativeSshTunnelSnapshot } from '@happier-dev/protocol/ssh/tunnels';

export type NativeSshCredentialsRef = Readonly<{
    remoteHostId: string;
    credentialId: string;
    storage: 'native-secure-storage' | 'session-memory';
}>;

export type NativeSshTunnelRequest = Readonly<{
    remoteHostId: string;
    sshTarget: string;
    sshPort?: number;
    destinationHost: '127.0.0.1' | 'localhost';
    destinationPort: number;
    purpose: NativeSshTunnelPurpose;
    credentialsRef: NativeSshCredentialsRef;
    requestedLocalPort?: number;
}>;

export type NativeSshTunnelAdapter = Readonly<{
    startLoopbackTunnel: (request: NativeSshTunnelRequest) => Promise<Readonly<{
        nativeTunnelId: string;
        localPort: number;
    }>>;
    stopLoopbackTunnel: (nativeTunnelId: string) => Promise<void>;
}>;

export type NativeSshTunnelProbeResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        reason:
            | 'remote-service-unreachable'
            | 'network-captive-portal'
            | 'loopback-bind-failed';
    }>;

export type NativeSshTunnelProbe = (url: string) => Promise<NativeSshTunnelProbeResult>;

export type NativeSshTunnelSupervisor = Readonly<{
    ensureTunnel: (request: NativeSshTunnelRequest) => Promise<NativeSshTunnelLease>;
    listTunnels: () => NativeSshTunnelSnapshot;
    releaseTunnel: (leaseId: string) => Promise<void>;
    markSuspended: () => void;
    markForeground: () => Promise<void>;
    dispose: () => Promise<void>;
}>;
