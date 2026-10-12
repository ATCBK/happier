import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { Context } from "@/context";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { prepareExternalIdentityConnection } from "./identity";
import { resolveOAuthRuntimeById } from "./identityProviderCatalog";
import type { ProviderReference } from "./providerReference";

function deploymentConfig(clientSecret: string): string {
    return JSON.stringify([
        {
            id: "acme",
            type: "oidc",
            displayName: "Acme",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            clientAuthenticationMethod: "client_secret_post",
            clientSecret,
            redirectUrl: "https://server.example.test/v1/oauth/acme/callback",
        },
    ]);
}

const originalConfig = process.env.AUTH_PROVIDERS_CONFIG_JSON;
let harness: LightSqliteHarness;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-identity-bound-reference-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
});

afterAll(async () => await harness.close());

afterEach(() => {
    if (originalConfig === undefined) delete process.env.AUTH_PROVIDERS_CONFIG_JSON;
    else process.env.AUTH_PROVIDERS_CONFIG_JSON = originalConfig;
});

async function boundReference(): Promise<ProviderReference> {
    process.env.AUTH_PROVIDERS_CONFIG_JSON = deploymentConfig("secret");
    const resolved = await resolveOAuthRuntimeById(process.env, "acme");
    if (!resolved) throw new Error("expected the deployment provider to resolve");
    return resolved.reference;
}

function connectionParams(reference: ProviderReference, providerId = "acme") {
    return {
        providerId,
        reference,
        ctx: Context.create("acct-1"),
        profile: { sub: "external-1" },
        accessToken: "token",
    };
}

describe("prepareExternalIdentityConnection provider binding (SQLite integration)", () => {
    it("refuses to link when the bound runtime configuration changed after authorization", async () => {
        const reference = await boundReference();
        process.env.AUTH_PROVIDERS_CONFIG_JSON = deploymentConfig("rotated");

        await expect(prepareExternalIdentityConnection(connectionParams(reference)))
            .rejects.toThrow("auth_provider_configuration_changed");
    });

    it("refuses to link when the bound provider no longer exists", async () => {
        const reference = await boundReference();
        delete process.env.AUTH_PROVIDERS_CONFIG_JSON;

        await expect(prepareExternalIdentityConnection(connectionParams(reference)))
            .rejects.toThrow("auth_provider_unavailable");
    });

    it("still resolves by id for a supported caller that carries no bound reference", async () => {
        process.env.AUTH_PROVIDERS_CONFIG_JSON = deploymentConfig("secret");
        const { reference: _unused, ...withoutReference } = connectionParams(
            await boundReference(),
            "not-configured",
        );

        await expect(prepareExternalIdentityConnection(withoutReference))
            .rejects.toThrow("unsupported-provider");
    });

    it("refuses to link when the route provider does not match the bound reference", async () => {
        const reference = await boundReference();

        await expect(prepareExternalIdentityConnection(connectionParams(reference, "github")))
            .rejects.toThrow("auth_provider_configuration_changed");
    });
});
