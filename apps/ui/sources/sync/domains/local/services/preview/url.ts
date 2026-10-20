import { isLoopbackHostname, normalizeHostnameForLoopbackCheck } from '@happier-dev/protocol/server/urls/loopbackHostname';

/**
 * The platform a local-service preview / browser surface is presented on.
 *
 * `desktop` is the Tauri/Wry desktop host (Phase 5.5 / finding #13). It is a non-native host like
 * `web` for loopback-policy purposes (a desktop WebView can load a loopback dev server), but it is a
 * DISTINCT identity from `web` so callers can express "this is the desktop app, not a browser tab"
 * directly — closing the finding #13 preview-platform leak together with the B-3 resolver guard
 * (`resolveBrowserSurfacePlatform`, which excludes a leaked `web` override).
 */
export type LocalServicePreviewPlatform = "web" | "desktop" | "ios" | "android";

export type LocalServicePreviewLoadUrlResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reasonCode: "invalid_url" | "native_loopback_not_allowed" | "unsupported_scheme" }>;

export type ResolveLocalServicePreviewLoadUrlInput = Readonly<{
    platform: LocalServicePreviewPlatform;
    url: string;
}>;

function parsePreviewUrl(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        return null;
    }
}

function isNativePlatform(platform: LocalServicePreviewPlatform): boolean {
    return platform === "ios" || platform === "android";
}

export function resolveLocalServicePreviewLoadUrl(
    input: ResolveLocalServicePreviewLoadUrlInput,
): LocalServicePreviewLoadUrlResult {
    const parsed = parsePreviewUrl(input.url);
    if (!parsed) {
        return { ok: false, reasonCode: "invalid_url" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, reasonCode: "unsupported_scheme" };
    }
    if (
        isNativePlatform(input.platform)
        && (
            isLoopbackHostname(parsed.hostname)
            || normalizeHostnameForLoopbackCheck(parsed.hostname) === "0.0.0.0"
        )
    ) {
        return { ok: false, reasonCode: "native_loopback_not_allowed" };
    }
    return { ok: true, url: parsed.toString() };
}

/**
 * The query parameter that carries a relay preview's one-use server admission. Only the frame's own
 * first request presents it (the server exchanges it for the frame's cookie); it is never part of the
 * page's address, its display, its copy, or any request the host makes on the frame's behalf.
 */
export const PREVIEW_ADMISSION_QUERY = 'previewToken';

/** The address without its admission. Unparseable input is returned unchanged. */
export function withoutPreviewAdmission(rawUrl: string): string {
    const parsed = parsePreviewUrl(rawUrl);
    if (!parsed || !parsed.searchParams.has(PREVIEW_ADMISSION_QUERY)) return rawUrl;
    parsed.searchParams.delete(PREVIEW_ADMISSION_QUERY);
    return parsed.toString();
}
