import type { PluginContributionRef } from './identity.js';

/** Declarative availability data is admitted by the host, not interpreted by authors. */
export type PluginAvailabilityDescriptor = unknown;

export type PluginRemediationData =
    | Readonly<{ kind: 'retry' }>
    | Readonly<{ kind: 'openSettings'; path: string }>
    | Readonly<{ kind: 'selectAccount'; service: PluginContributionRef }>
    | Readonly<{ kind: 'installDependency'; dependencyId: string }>
    | Readonly<{ kind: 'openUrl'; url: string }>;

export type PluginOperationAvailability =
    | Readonly<{ status: 'available' }>
    | Readonly<{ status: 'unavailable'; code: string; remediation?: PluginRemediationData }>
    | Readonly<{ status: 'denied'; code: string; remediation?: PluginRemediationData }>;
