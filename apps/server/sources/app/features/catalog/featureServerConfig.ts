import { FEATURE_CATALOG, type FeatureId } from '@happier-dev/protocol/features/catalog';
import { assertServerConfigEntry, type ServerConfigEntry, type ServerConfigSection } from '@happier-dev/protocol/serverConfig/serverConfigEntry';

import { FEATURE_ENV_KEYS } from './featureEnvSchema';
import { FEATURE_READER_DEFAULTS, type FeatureEnvProperty } from './featureReaderDefaults';

/**
 * The feature family of the server configuration registry, derived from `FEATURE_ENV_KEYS` (the
 * key names) and `FEATURE_READER_DEFAULTS` (their declarations). Nothing here is a second list.
 */
function enabledEnvKeyForFeature(featureId: string): string {
    const path = featureId
        .split('.')
        .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase())
        .join('_');
    return `HAPPIER_FEATURE_${path}__ENABLED`;
}

const FEATURE_ID_BY_ENABLED_KEY: ReadonlyMap<string, FeatureId> = new Map(
    (Object.keys(FEATURE_CATALOG) as FeatureId[]).map((featureId) => [enabledEnvKeyForFeature(featureId), featureId]),
);

/** The key's family: the feature id's first segment, else the key's own feature segment. */
function familyForKey(key: string, featureId: FeatureId | undefined): string {
    if (featureId) return featureId.split('.')[0]!;
    const segment = /^HAPPIER_(?:FEATURE_)?([A-Z0-9]+)/.exec(key)?.[1] ?? 'features';
    return segment.toLowerCase();
}

type FeatureConfigEntries = {
    readonly [P in FeatureEnvProperty]: (typeof FEATURE_READER_DEFAULTS)[P] & Readonly<{
        key: (typeof FEATURE_ENV_KEYS)[P];
        section: ServerConfigSection;
        family: string;
        description: string;
        featureId?: FeatureId;
    }>;
};

function buildFeatureConfigEntries(): FeatureConfigEntries {
    const out: Record<string, ServerConfigEntry> = {};
    for (const property of Object.keys(FEATURE_ENV_KEYS) as FeatureEnvProperty[]) {
        const key = FEATURE_ENV_KEYS[property];
        const declaration = FEATURE_READER_DEFAULTS[property] as (typeof FEATURE_READER_DEFAULTS)[FeatureEnvProperty] & {
            description?: string;
            featureId?: FeatureId;
            section?: ServerConfigSection;
        };
        const featureId = declaration.featureId ?? FEATURE_ID_BY_ENABLED_KEY.get(key);
        const description = declaration.description ?? (featureId ? FEATURE_CATALOG[featureId].description : undefined);
        if (!description) throw new Error(`Feature config ${key} needs a description or a catalog feature id.`);
        const entry: ServerConfigEntry = {
            ...declaration,
            key,
            section: declaration.section ?? 'features',
            family: familyForKey(key, featureId),
            description,
            ...(featureId ? { featureId } : {}),
        };
        assertServerConfigEntry(key, entry);
        out[property] = Object.freeze(entry);
    }
    return Object.freeze(out) as unknown as FeatureConfigEntries;
}

/** Feature entries by `FEATURE_ENV_KEYS` property, for `readFeatureEnv.ts`. */
export const FEATURE_CONFIG: FeatureConfigEntries = buildFeatureConfigEntries();

/** The feature family as registered with the server configuration registry. */
export const FEATURE_SERVER_CONFIG: readonly ServerConfigEntry[] = Object.freeze(
    Object.values(FEATURE_CONFIG) as ServerConfigEntry[],
);
