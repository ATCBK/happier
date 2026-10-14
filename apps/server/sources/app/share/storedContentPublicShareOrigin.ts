import { readLocalServicesFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { resolveLocalServiceHostOrigin } from "@/app/local/services/preview/origin";
import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

/** Private previews and raw local services never acquire the public viewer fallback. */
export function resolveIsolatedStoredContentPublicShareOrigin(shareId: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const result = resolveLocalServiceHostOrigin({
        publicBaseUrl: resolveConfiguredPublicServerUrl(env) ?? "",
        hostOriginBaseDomain: readLocalServicesFeatureEnv(env).previewHostOriginBaseDomain,
        resourceId: shareId,
    });
    return result.ok ? result.origin : null;
}

export function resolveStoredContentPublicShareDelivery(shareId: string, env: NodeJS.ProcessEnv = process.env): Readonly<{
    origin: string;
    mode: "isolated-origin" | "main-origin";
}> | null {
    const isolated = resolveIsolatedStoredContentPublicShareOrigin(shareId, env);
    if (isolated) return { origin: isolated, mode: "isolated-origin" };
    if (readServerConfig(env, SERVER_CONFIG.HAPPIER_PUBLIC_SHARES_ALLOW_SUBPATH) !== true) return null;
    const publicUrl = resolveConfiguredPublicServerUrl(env);
    if (!publicUrl) return null;
    const configured = new URL(publicUrl);
    return configured.protocol === "https:" ? { origin: configured.origin, mode: "main-origin" } : null;
}

export function resolveStoredContentPublicShareOrigin(shareId: string, env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveStoredContentPublicShareDelivery(shareId, env)?.origin ?? null;
}

/** Isolated Artifact public links retain the private preview's per-Artifact hostname. */
export function resolveStoredContentPublicShareSubjectOrigin(subject: Readonly<{ id: string; artifactId: string | null }>, env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveStoredContentPublicShareOrigin(subject.artifactId ?? subject.id, env);
}
