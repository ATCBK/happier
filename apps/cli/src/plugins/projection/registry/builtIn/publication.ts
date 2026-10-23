import { readFileSync } from 'node:fs';
import { assertHostCanExcludeBundledPlugin, BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH, parseBundledPluginPublicationFailures } from '@happier-dev/cli-common/bundledPluginPublicationPolicy';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import type { BundledPluginPublicationFailure } from '@/plugins/validation/diagnostics/types';

let admittedPublication: Readonly<{
    bytes: string;
    failures: readonly BundledPluginPublicationFailure[];
}> | null = null;

/** Runner staging consumes the publication admitted by this process, not later live writes. */
export function readAdmittedBundledPluginPublicationFailures(): string | null {
    return admittedPublication?.bytes ?? null;
}

export function readCurrentBundledPluginPublicationFailures(): readonly BundledPluginPublicationFailure[] {
    if (admittedPublication) return admittedPublication.failures;
    let raw: string;
    try {
        raw = readFileSync(resolveCliRuntimeAssetPath(
            BUNDLED_PLUGIN_PUBLICATION_FAILURES_RELATIVE_PATH,
        ), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('Bundled plugin publication state is unknown: the publication failure file is missing', { cause: error });
        }
        throw error;
    }
    const failures = parseBundledPluginPublicationFailures(raw);
    for (const failure of failures) {
        assertHostCanExcludeBundledPlugin('', failure.packageName, new Error(failure.diagnostic.message));
    }
    admittedPublication = Object.freeze({
        bytes: raw,
        failures: Object.freeze(failures.map((failure) => Object.freeze({
            ...failure, diagnostic: Object.freeze({ ...failure.diagnostic }),
        }))),
    });
    return admittedPublication.failures;
}


