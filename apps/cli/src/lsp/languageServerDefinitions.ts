import { posix } from 'node:path';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { ResolvedContributionRegistry, ResolvedLanguageServerContribution } from '@/plugins/projection/registry/types';

export type LanguageServerDefinition = Readonly<Omit<ResolvedLanguageServerContribution['definition'], 'id' | 'languageIds' | 'filePatterns' | 'rootMarkers' | 'args'> & {
    id: string;
    pluginId: string;
    pluginVersion?: string;
    manifestPath: string;
    languageIds: Readonly<Record<string, string>>;
    filePatterns?: readonly string[];
    rootMarkers?: readonly string[];
    args: readonly string[];
}>;

export type LanguageServerDefinitions = Readonly<{
    readLanguageServerDefinitions(): readonly LanguageServerDefinition[];
    findDefinitionsForDocument(input: Readonly<{ languageId: string | null; path: string }>): readonly LanguageServerDefinition[];
}>;

export function resolveLanguageServerDocumentLanguageId(
    definition: Pick<LanguageServerDefinition, 'languageIds'>,
    languageId: string | null,
): string | null {
    if (languageId !== null && Object.hasOwn(definition.languageIds, languageId))
        return definition.languageIds[languageId];
    // File patterns admit languages unknown to the host's highlighter. A single
    // declared LSP id is authoritative; several different ids cannot be inferred.
    const languageIds = new Set(Object.values(definition.languageIds));
    return languageIds.size === 1 ? languageIds.values().next().value! : null;
}

export function createLanguageServerDefinitions(options: Readonly<{
    readCurrentContributionRegistry: () => ResolvedContributionRegistry | null | undefined;
}>): LanguageServerDefinitions {
    const readLanguageServerDefinitions = (): readonly LanguageServerDefinition[] =>
        (options.readCurrentContributionRegistry()?.languageServers ?? []).map(contribution => ({
            ...contribution.definition,
            id: buildQualifiedPluginContributionKey(contribution.identity),
            pluginId: contribution.pluginId,
            ...(contribution.pluginVersion === undefined ? {} : { pluginVersion: contribution.pluginVersion }),
            manifestPath: contribution.manifestPath,
        }));
    const findDefinitionsForDocument = (input: Readonly<{ languageId: string | null; path: string }>): readonly LanguageServerDefinition[] => {
        const path = input.path.replace(/\\/gu, '/');
        return readLanguageServerDefinitions().filter(definition => (
            input.languageId !== null && Object.hasOwn(definition.languageIds, input.languageId)
            || definition.filePatterns?.some(pattern => posix.matchesGlob(path, pattern)
                || !pattern.includes('/') && posix.matchesGlob(posix.basename(path), pattern)))
            && resolveLanguageServerDocumentLanguageId(definition, input.languageId) !== null);
    };
    return { readLanguageServerDefinitions, findDefinitionsForDocument };
}

const currentDefinitions = createLanguageServerDefinitions({ readCurrentContributionRegistry });

export function readLanguageServerDefinitions(): readonly LanguageServerDefinition[] {
    return currentDefinitions.readLanguageServerDefinitions();
}

export function findDefinitionsForDocument(input: Readonly<{ languageId: string | null; path: string }>): readonly LanguageServerDefinition[] {
    return currentDefinitions.findDefinitionsForDocument(input);
}
