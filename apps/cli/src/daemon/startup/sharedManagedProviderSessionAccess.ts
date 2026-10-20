import { PluginError } from '@happier-dev/plugin-sdk';

import type { ResolvedManagedProviderRuntimeInvocationServices } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

type MaterializeSharedBinding = NonNullable<ResolvedManagedProviderRuntimeInvocationServices['materializeManagedProviderAgentBinding']>;
type SharedProjection = Pick<Parameters<MaterializeSharedBinding>[0], 'service' | 'projection'>;

/** Coalesces Session consumer establishment at its existing custody owner. */
export function createSharedManagedProviderSessionStart(input: Readonly<{
    start(): Promise<void>;
    readProjection(): SharedProjection | null;
}>) {
    let startPromise: Promise<void> | null = null;
    return () => {
        if (startPromise) return startPromise;
        const captured = input.readProjection();
        if (captured?.projection.isCurrent()) return Promise.resolve();
        startPromise = (async () => {
            if (captured) await captured.projection.cleanup();
            await input.start();
        })().finally(() => { startPromise = null; });
        return startPromise;
    };
}

/** Reads the exact daemon-owned consumer projection without rematerializing the Agent. */
export function createSharedManagedProviderSessionAccess(input: Readonly<{
    start(): Promise<void>;
    readProjection(): SharedProjection | null;
    materialize?: MaterializeSharedBinding;
    endpointTemplateId: string;
    revalidate(): Promise<boolean>;
}>) {
    return async (requestSignal?: AbortSignal) => {
        requestSignal?.throwIfAborted();
        await input.start();
        const captured = input.readProjection();
        if (!captured || !input.materialize || !await input.revalidate()) {
            // Withdraw this access claim, not its containing Session invocation.
            // A later request must freshly reauthorize before reacquiring it.
            await captured?.projection.cleanup();
            throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message: 'Managed gateway consumer access is unavailable',
            });
        }
        requestSignal?.throwIfAborted();
        const result = await input.materialize({
            ...captured,
            endpointTemplateId: input.endpointTemplateId,
            async materialize({ credentialPlaceholder }) {
                return {
                    v: 1,
                    kind: 'spawnEnv',
                    env: credentialPlaceholder === null ? [] : [{
                        name: 'HAPPIER_PROVIDER_GATEWAY_ACCESS',
                        value: credentialPlaceholder,
                        source: 'provider',
                    }],
                };
            },
        });
        if (!result) {
            await captured.projection.cleanup();
            throw new PluginError({
                code: 'plugin_services_managed_provider_authority_unavailable',
                message: 'Managed gateway consumer access changed',
            });
        }
        requestSignal?.throwIfAborted();
        return result.httpBinding;
    };
}
