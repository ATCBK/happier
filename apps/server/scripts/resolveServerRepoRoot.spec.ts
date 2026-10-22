import { describe, expect, it } from "vitest";

import { resolveServerRepoRoot } from "./resolveServerRepoRoot.mjs";

describe("resolveServerRepoRoot", () => {
    it("walks upward until it finds the monorepo root markers", () => {
        const root = resolveServerRepoRoot({
            startDir: "/repo/apps/server/scripts",
            existsSync: (path: string) => (
                path === "/repo/package.json"
                || path === "/repo/pnpm-lock.yaml"
                || path === "/repo/pnpm-workspace.yaml"
            ),
        });

        expect(root).toBe("/repo");
    });
});
