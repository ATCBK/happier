import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type {
    ExternalAgentObservationWatchFileChangesV1,
} from '@happier-dev/protocol';
import { ExternalAgentObservationWatchFileChangesV1Schema } from '@happier-dev/protocol/sessions/external/externalAgentObservationV1';
import type {
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    canonicalAbsolutePathsEqual,
    isCanonicalAbsolutePathInsideRoot,
    resolveCanonicalAbsoluteChildPathComparisonIdentity,
    resolveCanonicalAbsolutePathComparisonIdentity,
} from '@/utils/path/expandHomeDirPath';
import type { ConnectedServiceMaterializedStateObservationBinding } from '@/daemon/connectedServices/materialization/materializer';
import { isSafeConnectedServiceStateSharingEntry } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

function collectResolvedSourceAbsoluteRoots(value: unknown): string[] {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return isAbsolute(trimmed) ? [resolve(trimmed)] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(collectResolvedSourceAbsoluteRoots);
    }
    if (typeof value !== 'object' || value === null) {
        return [];
    }
    return Object.values(value).flatMap(collectResolvedSourceAbsoluteRoots);
}

function sourceRoots(
    linkedSource: AgentExternalSessionsResolvedIdentity,
    materializedBinding?: ConnectedServiceMaterializedStateObservationBinding,
): readonly Readonly<{ lexical: string; canonical: string }>[] {
    const roots = collectResolvedSourceAbsoluteRoots(linkedSource.source).map((root) => {
        try {
            return { lexical: root, canonical: realpathSync(root) };
        } catch {
            return { lexical: root, canonical: root };
        }
    });
    // Only host-captured, Session-bound materialization may extend a source's
    // physical roots. A current symlink or plugin declaration alone is no grant.
    if (!materializedBinding || !roots.some(root => canonicalAbsolutePathsEqual(
        root.canonical, materializedBinding.nativeHomeRoot,
    ))) return roots;
    for (const entry of materializedBinding.entries) {
        if (!isSafeConnectedServiceStateSharingEntry(entry.entryPath)) continue;
        const expectedEntry = resolveCanonicalAbsoluteChildPathComparisonIdentity(
            materializedBinding.nativeHomeRoot, entry.entryPath,
        );
        if (!expectedEntry || expectedEntry !== resolveCanonicalAbsolutePathComparisonIdentity(
            entry.materializedEntryPath,
        )) continue;
        try {
            const canonical = realpathSync(entry.materializedEntryPath);
            if (!canonicalAbsolutePathsEqual(canonical, entry.sourceEntryRoot)) continue;
            roots.push({ lexical: entry.materializedEntryPath, canonical });
        } catch {
            // Missing or retargeted materialized entries cannot reconstruct authority.
        }
    }
    return roots;
}

function isAuthorizedBySourceRoot(
    lexicalPath: string,
    canonicalPath: string,
    roots: readonly Readonly<{ lexical: string; canonical: string }>[],
): boolean {
    return roots.some((root) => (
        (
            isCanonicalAbsolutePathInsideRoot(root.lexical, lexicalPath)
            || isCanonicalAbsolutePathInsideRoot(root.canonical, lexicalPath)
        )
        && isCanonicalAbsolutePathInsideRoot(root.canonical, canonicalPath)
    ));
}

function canonicalizeMissingPathFromSourceRoot(
    lexicalPath: string,
    roots: readonly Readonly<{ lexical: string; canonical: string }>[],
): string | null {
    let ancestor = lexicalPath;
    while (true) {
        try {
            const canonicalAncestor = realpathSync(ancestor);
            if (!statSync(canonicalAncestor).isDirectory()) return null;
            const canonicalPath = resolve(canonicalAncestor, relative(ancestor, lexicalPath));
            return isAuthorizedBySourceRoot(lexicalPath, canonicalPath, roots)
                ? canonicalPath : null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        }
        try {
            // A dangling link is present, not an absent directory. Its future
            // target cannot acquire authority from its lexical source spelling.
            lstatSync(ancestor);
            return null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
    }
}

export function validateExternalSessionObservationWatchFileChanges(params: Readonly<{
    requested: ExternalAgentObservationWatchFileChangesV1 | undefined;
    linkedSource: AgentExternalSessionsResolvedIdentity;
    filesystemReadAllowedPaths: ReadonlySet<string>;
    previouslyAuthorizedFiles?: ReadonlySet<string>;
    materializedStateObservationBinding?: ConnectedServiceMaterializedStateObservationBinding;
}>): ExternalAgentObservationWatchFileChangesV1 | null | undefined {
    if (!params.requested) {
        return undefined;
    }
    if (params.filesystemReadAllowedPaths.size === 0) {
        return null;
    }
    const parsed = ExternalAgentObservationWatchFileChangesV1Schema.safeParse(
        params.requested,
    );
    if (!parsed.success) {
        return null;
    }
    const previouslyAuthorizedFiles = params.previouslyAuthorizedFiles ?? new Set();
    const roots = sourceRoots(params.linkedSource, params.materializedStateObservationBinding);
    if (roots.length === 0) {
        return null;
    }
    const files: string[] = [];
    for (const requestedFile of parsed.data.files) {
        const lexicalFile = resolve(requestedFile);
        let canonicalFile: string;
        try {
            canonicalFile = realpathSync(lexicalFile);
            if (!statSync(canonicalFile).isFile()) {
                return null;
            }
        } catch {
            const missingCanonicalFile = canonicalizeMissingPathFromSourceRoot(lexicalFile, roots);
            if (!missingCanonicalFile || !previouslyAuthorizedFiles.has(missingCanonicalFile)) {
                return null;
            }
            canonicalFile = missingCanonicalFile;
        }
        if (!isAuthorizedBySourceRoot(lexicalFile, canonicalFile, roots)) {
            return null;
        }
        if (files.includes(canonicalFile)) {
            return null;
        }
        files.push(canonicalFile);
    }
    const topologyDirectories: string[] = [];
    for (const requestedDirectory of parsed.data.topologyDirectories ?? []) {
        const lexicalDirectory = resolve(requestedDirectory);
        let canonicalDirectory: string;
        try {
            canonicalDirectory = realpathSync(lexicalDirectory);
            if (!statSync(canonicalDirectory).isDirectory()) {
                return null;
            }
            if (!isAuthorizedBySourceRoot(
                lexicalDirectory,
                canonicalDirectory,
                roots,
            )) {
                return null;
            }
        } catch {
            const missingCanonicalDirectory =
                canonicalizeMissingPathFromSourceRoot(lexicalDirectory, roots);
            if (!missingCanonicalDirectory) {
                return null;
            }
            canonicalDirectory = missingCanonicalDirectory;
        }
        if (topologyDirectories.includes(canonicalDirectory)) {
            return null;
        }
        topologyDirectories.push(canonicalDirectory);
    }
    return {
        files,
        ...(topologyDirectories.length > 0 ? { topologyDirectories } : {}),
    };
}
