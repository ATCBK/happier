import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { featuresRoutes } from "@/app/api/routes/features/featuresRoutes";
import type { FeaturesResponse } from "@/app/features/types";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("deployment OIDC environment secrets over HTTP", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-oidc-env-http-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });

    afterAll(async () => { await harness?.close(); });

    it("advertises valid providers, isolates missing secrets, and recovers without exposing secrets", async () => {
        const provider = {
            type: "oidc",
            displayName: "Acme",
            issuer: "https://issuer.example.test",
            clientId: "cid",
            redirectUrl: "https://server.example.test/v1/oauth/acme/callback",
        };
        delete process.env.AUTH_PROVIDERS_CONFIG_PATH;
        process.env.AUTH_PROVIDERS_CONFIG_JSON = JSON.stringify([
            { ...provider, id: "acme", clientSecretEnv: "ACME_OIDC_SECRET" },
            { ...provider, id: "literal", clientSecret: "literal-private-value" },
        ]);
        process.env.ACME_OIDC_SECRET = "env-private-value";

        const app = Fastify();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        featuresRoutes(app.withTypeProvider<ZodTypeProvider>());
        try {
            const address = await app.listen({ host: "127.0.0.1", port: 0 });
            const readFeatures = async () => {
                const response = await fetch(`${address}/v1/features`);
                expect(response.status).toBe(200);
                // Fastify validates the real HTTP response against the registered feature schema.
                return await response.json() as FeaturesResponse;
            };
            const valid = await readFeatures();
            expect(valid.capabilities.oauth.providers.acme).toMatchObject({ configured: true, enabled: true });

            delete process.env.ACME_OIDC_SECRET;
            const missing = await readFeatures();
            expect(missing.capabilities.oauth.providers).not.toHaveProperty("acme");
            expect(missing.capabilities.oauth.providers.literal).toMatchObject({ configured: true, enabled: true });
            expect(missing.capabilities.auth.misconfig).toContainEqual(expect.objectContaining({
                code: "auth_providers_config_invalid",
                message: expect.stringContaining("ACME_OIDC_SECRET"),
            }));

            process.env.ACME_OIDC_SECRET = "env-private-value";
            const recovered = await readFeatures();
            expect(recovered.capabilities.oauth.providers.acme).toMatchObject({ configured: true, enabled: true });
            const serialized = JSON.stringify([valid, missing, recovered]);
            expect(serialized).not.toContain("env-private-value");
            expect(serialized).not.toContain("literal-private-value");
        } finally {
            await app.close();
        }
    });
});
