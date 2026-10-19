import { describe, expect, it } from "vitest";

import { createSessionRouteTestBuilder } from "./sessionRoutes.testkit";

// Route graph loading is suite setup, outside the configuration assertion's test budget.
const builder = await createSessionRouteTestBuilder("GET", "/v2/sessions/:sessionId/messages/by-local-id/:localId");

describe("sessionRoutes v2 by-local-id rate limit", () => {
    it("registers GET /v2/sessions/:sessionId/messages/by-local-id/:localId with an explicit rate limit", () => {
        const route = builder.app.routes.get("GET /v2/sessions/:sessionId/messages/by-local-id/:localId");
        expect((route?.opts as any)?.config?.rateLimit).toEqual(
            expect.objectContaining({ max: expect.any(Number), timeWindow: expect.any(String) }),
        );
    });
});
