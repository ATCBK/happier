import { afterEach, describe, expect, it } from "vitest";

import { createStartServerHarness } from "./startServerHarness";

describe("startServerHarness", () => {
    const pathBaseline = process.env.PATH;
    const harness = createStartServerHarness({
        SERVER_ROLE: undefined,
        REDIS_URL: undefined,
        HAPPY_SERVER_LIGHT_DATA_DIR: undefined,
    });

    afterEach(() => {
        harness.restore();
    });

    it("restores the startup env baseline before each import preparation and override", () => {
        harness.reset({
            SERVER_ROLE: "stale-role",
            REDIS_URL: "redis://stale",
        });

        harness.prepareImport({
            SERVER_ROLE: "api",
            REDIS_URL: "redis://fresh",
        });

        expect(process.env.SERVER_ROLE).toBe("api");
        expect(process.env.REDIS_URL).toBe("redis://fresh");
        expect(process.env.PATH).toBe(pathBaseline);

        harness.reset();
        expect(process.env.SERVER_ROLE).toBeUndefined();
        expect(process.env.REDIS_URL).toBeUndefined();
        expect(process.env.PATH).toBe(pathBaseline);

        harness.restore();

        expect(process.env.SERVER_ROLE).toBeUndefined();
        expect(process.env.REDIS_URL).toBeUndefined();
        expect(process.env.PATH).toBe(pathBaseline);
    });
});
