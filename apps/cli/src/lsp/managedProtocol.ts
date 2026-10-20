import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import { DEFAULT_JSON_RPC_MAX_FRAME_BYTES } from '@/plugins/runtime/exec/jsonRpc';
import type { ProcessOwnerRef } from '@/processes/ownerTag';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { logger } from '@/ui/logger';
import type { LanguageServerDefinition } from './languageServerDefinitions';

export type OpenLanguageServerProtocolInput = Readonly<{
    definition: Pick<LanguageServerDefinition, 'id' | 'pluginId' | 'executable' | 'args'>;
    rootPath: string;
    processOwner: ProcessOwnerRef;
    signal: AbortSignal;
}>;

export class LanguageServerProtocolUnavailableError extends PluginError {
    readonly reason = 'server_missing' as const;
    readonly installable?: Extract<ManagedExecutableRef, { kind: 'managedDependency' }>;

    constructor(executable: ManagedExecutableRef, cause?: unknown) {
        super({ code: 'server_missing', message: 'The declared language server executable is unavailable' }, { cause });
        if (executable.kind === 'managedDependency') this.installable = executable;
    }
}

export function createLanguageServerProtocolOpener(options: Readonly<{
    acquireRuntimeRegistry(): Promise<PluginRuntimeRegistryLease>;
}>): (input: OpenLanguageServerProtocolInput) => Promise<PluginProtocolClientHandle<'jsonRpc'>> {
    return async input => {
        input.signal.throwIfAborted();
        const lease = await options.acquireRuntimeRegistry();
        try {
            const registry = lease.registry;
            const occurrenceId = registry.readPluginOccurrenceId?.(input.definition.pluginId);
            const service = createStablePluginExecService({
                processOwner: input.processOwner,
                allowedExecutables: [input.definition.executable],
                signal: input.signal,
                isOccurrenceCurrent: () => Boolean(occurrenceId
                    && registry.isPluginOccurrenceCurrent?.(input.definition.pluginId, occurrenceId)),
                async resolveExecutable(executable) {
                    if (!registry.resolveReadyManagedExecutable) throw new LanguageServerProtocolUnavailableError(executable);
                    try {
                        return await registry.resolveReadyManagedExecutable(executable, input.definition.pluginId);
                    } catch (error) {
                        input.signal.throwIfAborted();
                        throw new LanguageServerProtocolUnavailableError(executable, error);
                    }
                },
                // Launch cwd is the host-authorized absolute workspace path, so no plugin
                // filesystem path is consumed by this service.
                resolvePath: async () => input.rootPath,
            });
            const handle = await service.clients.spawn({
                kind: 'jsonRpc', framing: 'contentLength',
                maxFrameBytes: DEFAULT_JSON_RPC_MAX_FRAME_BYTES,
                cancellationMethod: '$/cancelRequest',
                launch: { executable: input.definition.executable, args: input.definition.args, cwd: input.rootPath },
            });
            const stderr = handle.process.onOutput(output => {
                if (output.stream === 'stderr') logger.infoFile('[LanguageServer] stderr', {
                    serverId: input.definition.id, text: Buffer.from(output.data).toString('utf8'),
                });
            });
            // Preserve the canonical handle identity for its host-private disposal hook.
            void handle.wait().finally(async () => {
                stderr.dispose();
                await lease.release();
            }).catch(error => logger.infoFile('[LanguageServer] Runtime lease cleanup failed', error));
            return handle;
        } catch (error) {
            await lease.release();
            throw error;
        }
    };
}

export const openLanguageServerProtocol = createLanguageServerProtocolOpener({
    acquireRuntimeRegistry: () => pluginReloadController.acquireRuntimeRegistry(),
});
