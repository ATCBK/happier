import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { computePluginUiArtifactSha256DigestV1, PluginUiArtifactDigestV1Schema, type PluginUiArtifactDigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';

import type { Tx } from "@/storage/inTx";

/**
 * The admitted normalized manifest a daemon-selected (bundled first-party,
 * trusted development, drop-in) host claimed for a release-less Account
 * intent. The digest is computed here, never supplied by the claimant.
 */
export type ReleaseLessDeclarationV1 = Readonly<{
    manifestDigestSha256: PluginUiArtifactDigestV1;
    manifest: ParsedPluginManifestV2;
}>;

/**
 * The manifest that currently declares a plugin's Account-scoped
 * contributions (webhooks, automation Events) for one exact version, plus the
 * declaration identity Event definitions bind to: the selected release's
 * archive digest, or the claimed manifest digest of a release-less intent.
 */
export type CurrentPluginDeclarationV1 = Readonly<{
    manifest: ParsedPluginManifestV2;
    declarationDigestSha256: PluginUiArtifactDigestV1;
}>;

type StoredDeclarationIntentRow = Readonly<{
    enabled: boolean;
    desiredVersion: string | null;
    releaseLessDeclaration: unknown;
}>;

export function createReleaseLessDeclarationV1(manifest: ParsedPluginManifestV2): ReleaseLessDeclarationV1 {
    return {
        manifestDigestSha256: computePluginUiArtifactSha256DigestV1(
            new TextEncoder().encode(createCanonicalJsonSigningInput(manifest)),
        ),
        manifest,
    };
}

/**
 * Claims and release publication validate and normalize the body before the
 * sole Availability writer stores it. Reads check its identifying envelope;
 * they do not re-admit every contribution in that server-owned body.
 */
export function readStoredPluginManifestV2(stored: unknown, pluginId: string): ParsedPluginManifestV2 | null {
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
    const value = stored as Readonly<Record<string, unknown>>;
    if (value.schemaVersion !== 2 || value.id !== pluginId || typeof value.version !== "string"
        || value.contributes === null || typeof value.contributes !== "object" || Array.isArray(value.contributes)) return null;
    // This database boundary reads the normalized output of the validated producer above.
    return stored as ParsedPluginManifestV2;
}

function readReleaseLessDeclarationV1(
    stored: unknown,
    pluginId: string,
): ReleaseLessDeclarationV1 | null {
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
    const value = stored as Readonly<Record<string, unknown>>;
    const digest = PluginUiArtifactDigestV1Schema.safeParse(value.manifestDigestSha256);
    const manifest = readStoredPluginManifestV2(value.manifest, pluginId);
    if (!digest.success || !manifest) return null;
    return { manifestDigestSha256: digest.data, manifest };
}

/**
 * The release-less declaration of an intent, only while no release is
 * selected: a present-user release selection always wins over a claim.
 */
export function readCurrentReleaseLessDeclarationV1(
    intent: Readonly<{ desiredVersion: string | null; releaseLessDeclaration: unknown }> | null | undefined,
    pluginId: string,
): ReleaseLessDeclarationV1 | null {
    if (!intent || intent.desiredVersion !== null) return null;
    return readReleaseLessDeclarationV1(intent.releaseLessDeclaration, pluginId);
}

/** An enabled intent that selects either a portable release or a claimed declaration. */
export function isPluginIntentSelectingDeclarationV1(
    intent: StoredDeclarationIntentRow | null | undefined,
    pluginId: string,
): boolean {
    return intent?.enabled === true
        && (intent.desiredVersion !== null || readCurrentReleaseLessDeclarationV1(intent, pluginId) !== null);
}

function declarationRefKey(pluginId: string, version: string): string {
    return `${pluginId}\0${version}`;
}

/**
 * The one current-declaration reader for Account-scoped plugin contributions.
 * An exact `pluginId@version` is current only while the Account intent is
 * enabled and selects it: through the selected portable release, or, when no
 * release is selected, through the release-less declaration its host claimed.
 * Fixed database work regardless of the number of refs.
 */
export async function resolveCurrentPluginDeclarationsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    refs: readonly Readonly<{ pluginId: string; version: string }>[];
}>): Promise<ReadonlyMap<string, CurrentPluginDeclarationV1>> {
    const resolved = new Map<string, CurrentPluginDeclarationV1>();
    if (params.refs.length === 0) return resolved;
    const pluginIds = [...new Set(params.refs.map((ref) => ref.pluginId))];
    const intents = await params.tx.accountPluginIntent.findMany({
        where: { accountId: params.accountId, pluginId: { in: pluginIds } },
        select: { pluginId: true, enabled: true, desiredVersion: true, releaseLessDeclaration: true },
    });
    const intentsByPluginId = new Map(intents.map((intent) => [intent.pluginId, intent] as const));
    const releaseRefs = [...new Map(params.refs.flatMap((ref) => (
        intentsByPluginId.get(ref.pluginId)?.desiredVersion === ref.version
            ? [[declarationRefKey(ref.pluginId, ref.version), ref] as const]
            : []
    ))).values()];
    const releases = releaseRefs.length === 0
        ? []
        : await params.tx.accountPluginRelease.findMany({
            where: {
                accountId: params.accountId,
                OR: releaseRefs.map((ref) => ({ pluginId: ref.pluginId, version: ref.version })),
            },
            select: { pluginId: true, version: true, archiveDigestSha256: true, normalizedManifest: true },
        });
    const releasesByRef = new Map(releases.map((release) => [
        declarationRefKey(release.pluginId, release.version),
        release,
    ] as const));
    for (const ref of params.refs) {
        const intent = intentsByPluginId.get(ref.pluginId);
        if (!intent?.enabled) continue;
        const key = declarationRefKey(ref.pluginId, ref.version);
        if (intent.desiredVersion === ref.version) {
            const release = releasesByRef.get(key);
            const manifest = readStoredPluginManifestV2(release?.normalizedManifest, ref.pluginId);
            const digest = PluginUiArtifactDigestV1Schema.safeParse(release?.archiveDigestSha256);
            if (!manifest || !digest.success || manifest.version !== ref.version) continue;
            resolved.set(key, {
                manifest,
                declarationDigestSha256: digest.data,
            });
            continue;
        }
        const declaration = readCurrentReleaseLessDeclarationV1(intent, ref.pluginId);
        if (declaration?.manifest.version !== ref.version) continue;
        resolved.set(key, {
            manifest: declaration.manifest,
            declarationDigestSha256: declaration.manifestDigestSha256,
        });
    }
    return resolved;
}

export async function resolveCurrentPluginDeclarationTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
}>): Promise<CurrentPluginDeclarationV1 | null> {
    const resolved = await resolveCurrentPluginDeclarationsTx({
        tx: params.tx,
        accountId: params.accountId,
        refs: [{ pluginId: params.pluginId, version: params.version }],
    });
    return resolved.get(declarationRefKey(params.pluginId, params.version)) ?? null;
}

export function currentPluginDeclarationKeyV1(pluginId: string, version: string): string {
    return declarationRefKey(pluginId, version);
}
