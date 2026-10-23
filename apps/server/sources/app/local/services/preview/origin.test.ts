import { describe, expect, it } from "vitest";

type PreviewOriginModule = typeof import("./origin");

async function loadPreviewOriginModule(): Promise<PreviewOriginModule | null> {
    return import("./origin").catch(() => null);
}

describe("local service preview origin policy", () => {
    it.each([
        { publicBaseUrl: "http://localhost:8181", hostOriginBaseDomain: "localhost", origin: "http://preview-123.localhost:8181" },
        { publicBaseUrl: "http://home.localhost:8181", hostOriginBaseDomain: "preview.localhost", origin: "http://preview-123.preview.localhost:8181" },
        { publicBaseUrl: "https://home.example.test:8443", hostOriginBaseDomain: "preview.example.test", origin: "https://preview-123.preview.example.test:8443" },
    ])("preserves the admitted Home scheme and port ($publicBaseUrl)", async ({ publicBaseUrl, hostOriginBaseDomain, origin }) => {
        const mod = await loadPreviewOriginModule();
        expect(mod?.resolveLocalServiceHostOrigin({ publicBaseUrl, hostOriginBaseDomain, resourceId: "preview_123" }))
            .toEqual({ ok: true, origin });
    });

    it.each(["http://127.0.0.1:8181", "http://[::1]:8181", "http://home.local:8181", "http://localhost.example.test:8181", "http://notlocalhost:8181"])(
        "keeps HTTPS required outside localhost names (%s)", async (publicBaseUrl) => {
            const mod = await loadPreviewOriginModule();
            expect(mod?.resolveLocalServiceHostOrigin({ publicBaseUrl, hostOriginBaseDomain: "preview.localhost", resourceId: "preview_123" }))
                .toEqual({ ok: false, reasonCode: "https_required" });
        },
    );

    it("refuses an HTTP preview domain outside localhost even on a loopback Home", async () => {
        const mod = await loadPreviewOriginModule();
        expect(mod?.resolveLocalServiceHostOrigin({ publicBaseUrl: "http://home.localhost:8181", hostOriginBaseDomain: "preview.example.test", resourceId: "preview_123" }))
            .toEqual({ ok: false, reasonCode: "https_required" });
    });

    it("builds host-origin preview urls and preserves initial path query", async () => {
        const mod = await loadPreviewOriginModule();

        const result = mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            previewId: "preview_123",
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
            token: "token_123",
        });

        expect(result).toEqual({
            ok: true,
            url: "https://preview-123.preview.happier.test/dashboard?tab=preview&previewToken=token_123",
            origin: "https://preview-123.preview.happier.test",
        });
    });

    it("refuses path-mode previews on the API origin", async () => {
        const mod = await loadPreviewOriginModule();

        const result = mod?.resolveLocalServicePreviewUrl({
            // @ts-expect-error Retired wire input must never expose the API origin.
            originMode: "path",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            previewId: "preview_123",
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
            token: "token_123",
        });

        expect(result).toEqual({ ok: false, reasonCode: "host_origin_unavailable" });
    });

    it("refuses a configured preview hostname that equals the API origin", async () => {
        const mod = await loadPreviewOriginModule();
        expect(mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "https://preview-123.preview.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "host_origin_unavailable" });
    });

    it("rejects path-mode fallback for non-http public base URLs", async () => {
        const mod = await loadPreviewOriginModule();

        expect(mod?.resolveLocalServicePreviewUrl({
            // @ts-expect-error Retired wire input must not enable a fallback.
            originMode: "path",
            publicBaseUrl: "ftp://app.happier.test",
            hostOriginBaseDomain: null,
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "invalid_public_base_url" });
    });

    it("rejects host-origin mode when DNS/TLS host configuration is absent or non-https", async () => {
        const mod = await loadPreviewOriginModule();

        expect(mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "host_origin_unavailable" });

        expect(mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "http://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "https_required" });
    });

    it("rejects host-origin base domains that are not plain DNS names", async () => {
        const mod = await loadPreviewOriginModule();

        for (const hostOriginBaseDomain of [
            "https://preview.happier.test",
            "preview.happier.test/path",
            "preview.happier.test:8443",
            "-preview.happier.test",
        ]) {
            expect(mod?.resolveLocalServicePreviewUrl({
                originMode: "host",
                publicBaseUrl: "https://app.happier.test",
                hostOriginBaseDomain,
                previewId: "preview_123",
                initialPath: { pathname: "/", search: "" },
                token: "token_123",
            })).toEqual({ ok: false, reasonCode: "host_origin_unavailable" });
        }
    });
});
