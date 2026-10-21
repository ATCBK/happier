import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const expandMigrationId = "20260810200000_expand_session_turn_anchor_projection";

describe("SessionTurn transcript-anchor projection storage contract", () => {
    it.each([
        "prisma",
        "prisma/sqlite",
        "prisma/mysql",
    ] as const)("keeps %s legacy rows distinguishable for automatic startup conversion", (providerRoot) => {
        const sql = readFileSync(join(serverRoot, providerRoot, "migrations", expandMigrationId, "migration.sql"), "utf8")
            .replace(/[`\"]/g, "");
        expect(sql).toMatch(/transcriptAnchorProjectionVersion\s+INTEGER\s+NOT NULL\s+DEFAULT 0/);
        expect(sql).toContain("SessionTurn_transcript_anchor_range_idx");
        const schema = readFileSync(join(serverRoot, providerRoot, "schema.prisma"), "utf8");
        expect(schema).toMatch(/transcriptAnchorProjectionVersion\s+Int\s+@default\(0\)/);
        expect(schema).toContain('@@index([sessionId, transcriptAnchorProjectionVersion, transcriptAnchorMaxSeq, transcriptAnchorMinSeq]');
    });
});
