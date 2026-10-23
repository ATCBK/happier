/** @moduleRealm daemon */
import type { PluginContributionLocalId } from '@happier-dev/protocol';
import type { PluginInvocationContext } from './invocation.js';

export type { BackgroundServiceContribution } from '@happier-dev/protocol';

export type BackgroundServiceDefinition = Readonly<{
    declaration: import('@happier-dev/protocol').BackgroundServiceContribution;
    runner: BackgroundServiceRunner;
}>;

export type BackgroundServiceContext =
    Omit<PluginInvocationContext, 'surface' | 'session'>
    & Readonly<{
        surface: 'background';
        session?: undefined;
    }>;

export type BackgroundServiceRunner = (
    context: BackgroundServiceContext,
) => Promise<void>;

/** One caller's demand; cancelling it never cancels another caller's demand. */
export type BackgroundServiceDemandHandle = Readonly<{
    /** Successful settlement joins the finite batch, its cleanup, and any child process exit. */
    settlement: Promise<void>;
    /** Rejects only this caller's settlement; other coalesced callers keep running. */
    cancel(): void;
}>;

/** Available in daemon invocations for the declaring plugin's services. */
export interface BackgroundServicesService {
    demand(localId: PluginContributionLocalId, reason?: string): BackgroundServiceDemandHandle;
}

export interface BackgroundServicesRegistrationApi {
    register(
        localId: PluginContributionLocalId,
        runner: BackgroundServiceRunner,
    ): void;
}
