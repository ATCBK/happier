import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { resolveServerScriptCommandInvocation } from "../../scripts/runCommand";

describe("migrate:light:deploy (db contract)", () => {
    it("applies the full Prisma migration chain deterministically on a fresh embedded pglite DB", async () => {
        // Vitest runs this suite from the server workspace root (`apps/server`).
        // Using `import.meta.url` here is brittle under Vite transforms.
        const serverRoot = process.cwd();
        const dataDir = await mkdtemp(join(tmpdir(), "happier-migrate-light-"));
        try {
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                // Ensure the script uses an isolated directory (never the developer's real one).
                HAPPY_SERVER_LIGHT_DATA_DIR: dataDir,
                HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
            };

            const invocation = resolveServerScriptCommandInvocation("pnpm", ["--silent", "run", "migrate:light:deploy"], env);
            const res = spawnSync(invocation.command, invocation.args, {
                cwd: serverRoot,
                env: env as Record<string, string>,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            });

            if (res.status !== 0) {
                const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
                throw new Error(`migrate:light:deploy failed (status=${res.status}). ${out}`.trim());
            }

            expect(res.status).toBe(0);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});
