import { describe, expect, it, vi } from "vitest";
import { PluginManifestV2Schema } from "@happier-dev/protocol/plugins/manifest/v2";

import { createReleaseLessDeclarationV1, readCurrentReleaseLessDeclarationV1 } from "./currentDeclaration";

function declaration() {
    return createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
        schemaVersion: 2,
        id: "com.example.external",
        version: "1.2.3",
        displayName: "External plugin",
        engines: { happier: "^1.0.0" },
        runtime: { apiVersion: 1 },
        contributes: {},
    }));
}

describe("server-owned plugin declarations", () => {
    it("reads the admitted body without repeating manifest validation", () => {
        const stored = declaration();
        const parse = vi.spyOn(PluginManifestV2Schema, "safeParse");
        try {
            for (let read = 0; read < 5; read++) {
                expect(readCurrentReleaseLessDeclarationV1({ desiredVersion: null, releaseLessDeclaration: stored },
                    stored.manifest.id)).toEqual(stored);
            }
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
    });

    it("refuses invalid identifying envelopes and defers to an explicit release selection", () => {
        const stored = declaration();
        const read = (releaseLessDeclaration: unknown, desiredVersion: string | null = null) => (
            readCurrentReleaseLessDeclarationV1({ desiredVersion, releaseLessDeclaration }, stored.manifest.id)
        );
        expect(read(stored, "1.2.3")).toBeNull();
        expect(read(null)).toBeNull();
        expect(read({ ...stored, manifestDigestSha256: "invalid" })).toBeNull();
        expect(read({ ...stored, manifest: { ...stored.manifest, id: "com.example.other" } })).toBeNull();
        expect(read({ ...stored, manifest: { ...stored.manifest, version: 7 } })).toBeNull();
        expect(read({ ...stored, manifest: { ...stored.manifest, schemaVersion: 1 } })).toBeNull();
    });
});
