import type { ActivationTarget } from '../activation/targets';
import type { PluginActivationSource, PluginActivationProcessEntry } from '../../activationSources';
import type { PluginRuntimeSourceAuthority, PluginSourceCustody } from '../../sourceAuthority';
import { resolvePluginSourceCustody, pluginSourceCustodyEqual } from '../../sourceAuthority';
import type { PluginDaemonModuleNamespace } from '../../types';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

export type AdmittedBackgroundServicePlugin = Readonly<{
    target: ActivationTarget;
    occurrenceId: string;
    sourceCustody: PluginSourceCustody;
    sourceAuthority: PluginRuntimeSourceAuthority;
    processEntry: PluginActivationProcessEntry;
    moduleId?: string;
    committedAuthorization?: import('../../activationSources').CommittedPluginExecutionAuthorization;
}>;

/** Project the source selected by the canonical admission owner; never discover another source. */
export function projectAdmittedBackgroundServicePlugin(input: Readonly<{
    target: ActivationTarget;
    occurrenceId: string;
    sourceCustody: PluginSourceCustody;
    source: PluginActivationSource<PluginDaemonModuleNamespace>;
}>): AdmittedBackgroundServicePlugin {
    const authority = input.source.sourceAuthority;
    if (!authority || !pluginSourceCustodyEqual(resolvePluginSourceCustody(authority), input.sourceCustody)) {
        throw new Error('background_service_process_source_custody_unavailable');
    }
    const rootPath = authority.kind === 'development' ? authority.canonicalRoot : authority.resolvedRoot;
    const processEntry = input.source.kind === 'file_backed'
        ? {
            entryPath: input.source.useDevelopmentEntry ? input.source.devEntryPath ?? input.source.entryPath : input.source.entryPath,
            rootPath,
            loadMode: input.source.useDevelopmentEntry ? 'source-ts' as const : 'immutable-js' as const,
        }
        : input.source.processEntry;
    if (!processEntry || processEntry.rootPath !== rootPath
        || !isCanonicalAbsolutePathInsideRoot(rootPath, processEntry.entryPath)) {
        throw new Error('background_service_process_entry_unavailable');
    }
    return Object.freeze({
        target: input.target,
        occurrenceId: input.occurrenceId,
        sourceCustody: input.sourceCustody,
        sourceAuthority: authority,
        processEntry,
        ...(input.source.kind === 'bundled' ? { moduleId: input.source.moduleId } : {}),
        ...(input.source.kind !== 'bundled' && input.source.committedAuthorization
            ? { committedAuthorization: input.source.committedAuthorization } : {}),
    });
}
