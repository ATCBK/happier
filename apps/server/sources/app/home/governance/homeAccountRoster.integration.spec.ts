import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
    decodeKeysetCursorV1,
    encodeKeysetCursorV1,
    HomeAccountListInputV1Schema,
    HomeAccountListResultV1Schema,
    type HomeRoleV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { listHomeAccountsInTx } from "./homeGovernanceService";

let harness: LightSqliteHarness;
const ENV: NodeJS.ProcessEnv = { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" };
const QUERY = "home-accounts:role-label:v1";

async function account(id: string, homeRole: HomeRoleV1, name: string | null, username: string | null = null) {
    await db.account.create({ data: { id, publicKey: `roster-fixture-${id}`, homeRole, name, username } });
    return id;
}

async function page(actorAccountId: string, cursor: string | null = null, limit = 2) {
    const result = await inTx((tx) => listHomeAccountsInTx(tx, { emailDeliveryReady: false, actorAccountId, env: ENV, cursor, limit }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected roster page");
    return HomeAccountListResultV1Schema.parse(result.result);
}

async function allPages(actorAccountId: string, cursor: string | null = null) {
    const ids: string[] = [];
    do {
        const result = await page(actorAccountId, cursor);
        ids.push(...result.items.map((row) => row.accountId));
        expect(new Set(ids).size).toBe(ids.length);
        cursor = result.nextCursor;
    } while (cursor);
    return ids;
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-account-roster-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
});
afterAll(async () => { if (harness) await harness.close(); });
afterEach(async () => { await db.account.deleteMany({}); });

describe("Home People server ordering", () => {
    it("pages owners, admins, then members by folded display label and id, with unnamed last in each role", async () => {
        // Insertion order deliberately disagrees with every sorting key.
        await account("member-unnamed-z", "member", null);
        await account("member-b", "member", "aLPHa");
        await account("admin-z", "admin", " Zulu ");
        const actor = await account("owner-z", "owner", "Zulu");
        await account("member-unnamed-a", "member", " \t\n\u00a0\u3000\ufeff", "\t");
        await account("member-a", "member", "Alpha");
        await account("admin-unnamed", "admin", null);
        await account("owner-a", "owner", " Alpha ", "ignored-username");
        await account("admin-a", "admin", " \t", " alpha ");
        await account("member-z", "member", "Zulu", "aaa-ignored");
        const expected = [
            "owner-a", "owner-z", "admin-a", "admin-z", "admin-unnamed",
            "member-a", "member-b", "member-z", "member-unnamed-a", "member-unnamed-z",
        ];
        expect(await allPages(actor)).toEqual(expected);
    });

    it("round-trips a captured cursor and orders very long names by only their first 32 code points", async () => {
        const prefix = "A".repeat(32);
        // Beyond sort precision, id wins even though the full names order oppositely.
        await account("owner-b", "owner", prefix + "A".repeat(19_968));
        const actor = await account("owner-a", "owner", prefix + "Z".repeat(19_968));
        await account("owner-z", "owner", "Z");
        const first = await page(actor, null, 1);
        expect(first.items.map((row) => row.accountId)).toEqual([actor]);
        expect(first.items[0]?.profile.name).toHaveLength(20_000);
        expect(first.nextCursor).not.toBeNull();
        expect(first.nextCursor!.length).toBeLessThanOrEqual(512);
        expect(decodeKeysetCursorV1(first.nextCursor!, QUERY)).toEqual({ status: "ok", parts: [0, 0, prefix.toLowerCase(), actor] });
        const input = HomeAccountListInputV1Schema.parse({ cursor: first.nextCursor, limit: 1 });
        const next = await page(actor, input.cursor, 1);
        expect(next.items.map((row) => row.accountId)).toEqual(["owner-b"]);
        expect(await allPages(actor, next.nextCursor)).toEqual(["owner-z"]);
    });

    it.each(["漢", "😀"])("uses 32 code points of a non-ASCII name (%#)", async (character) => {
        const prefix = character.repeat(32);
        // UTF-16 slicing would retain only 16 emoji; the captured tuple must retain 32.
        const actor = await account("00000000-0000-0000-0000-000000000000", "owner", prefix + "Z");
        const other = await account("ffffffff-ffff-ffff-ffff-ffffffffffff", "owner", prefix + "A");
        const first = await page(actor, null, 1);
        expect(first.items.map((row) => row.accountId)).toEqual([actor]);
        expect(first.nextCursor).not.toBeNull();
        expect(decodeKeysetCursorV1(first.nextCursor!, QUERY)).toEqual({ status: "ok", parts: [0, 0, prefix, actor] });
        expect(await allPages(actor, first.nextCursor)).toEqual([other]);
    });

    it.each([
        "not-a-cursor",
        encodeKeysetCursorV1({ queryKey: "home-audit:v1", parts: [0, "owner"] }),
        encodeKeysetCursorV1({ queryKey: "home-accounts:v1", parts: [0, "owner"] }),
        ...[
            [3, 0, "owner", "owner"], [-1, 0, "owner", "owner"], [0.5, 0, "owner", "owner"],
            ["0", 0, "owner", "owner"], [0, 2, "owner", "owner"], [0, "0", "owner", "owner"],
            [0, 0, "owner", ""], [0, 0, "x".repeat(33), "owner"], [0, 0, "😀".repeat(33), "owner"], [0, 0, 0, "owner"],
            [0, 0, "owner"], [0, "owner"],
        ]
            .map((parts) => encodeKeysetCursorV1({ queryKey: QUERY, parts })),
    ])("rejects a malformed or foreign cursor (%#)", async (cursor) => {
        const actor = await account("owner", "owner", "Owner");
        expect(await inTx((tx) => listHomeAccountsInTx(tx, { emailDeliveryReady: false, actorAccountId: actor, env: ENV, cursor })))
            .toEqual({ status: "rejected", code: "invalid_home_cursor" });
    });

    it("allows a renamed row to move before the boundary while preserving unchanged rows", async () => {
        const actor = await account("owner", "owner", "Owner");
        await account("member-charlie", "member", "Charlie");
        await account("member-delta", "member", "Delta");
        await account("member-echo", "member", "Echo");
        const first = await page(actor);
        expect(first.items.map((row) => row.accountId)).toEqual([actor, "member-charlie"]);
        await db.account.update({ where: { id: "member-delta" }, data: { name: "Alpha" } });
        expect(await allPages(actor, first.nextCursor)).toEqual(["member-echo"]);
    });

    it("allows an already-seen non-boundary row to move after the boundary while preserving unchanged rows", async () => {
        const actor = await account("owner", "owner", "Owner");
        await account("member-alpha", "member", "Alpha");
        await account("member-bravo", "member", "Bravo");
        await account("member-charlie", "member", "Charlie");
        await account("member-delta", "member", "Delta");
        const first = await page(actor, null, 3);
        expect(first.items.map((row) => row.accountId)).toEqual([actor, "member-alpha", "member-bravo"]);
        await db.account.update({ where: { id: "member-alpha" }, data: { name: "Zulu" } });
        expect(await allPages(actor, first.nextCursor)).toEqual(["member-charlie", "member-delta", "member-alpha"]);
    });

    it("preserves unchanged rows when the boundary name itself changes", async () => {
        const actor = await account("owner", "owner", "Owner");
        await account("member-bravo", "member", "Bravo");
        await account("member-charlie", "member", "Charlie");
        await account("member-delta", "member", "Delta");
        const first = await page(actor);
        expect(first.items.map((row) => row.accountId)).toEqual([actor, "member-bravo"]);
        await db.account.update({ where: { id: "member-bravo" }, data: { name: "Zulu" } });
        // Standard keyset semantics allow only the changed row to recur.
        expect(await allPages(actor, first.nextCursor)).toEqual(["member-charlie", "member-delta", "member-bravo"]);
    });

    it("continues from the captured tuple when the boundary Account was removed", async () => {
        const actor = await account("owner", "owner", "Owner");
        await account("member-b", "member", "Bravo");
        await account("member-c", "member", "Charlie");
        await account("member-d", "member", "Delta");
        await account("admin", "admin", "Admin");
        const first = await page(actor, null, 3);
        expect(first.items.map((row) => row.accountId)).toEqual([actor, "admin", "member-b"]);
        await db.account.delete({ where: { id: "member-b" } });
        expect(await allPages(actor, first.nextCursor)).toEqual(["member-c", "member-d"]);
    });

    it("preserves unchanged rows after boundary deletion even when label and id order disagree", async () => {
        const actor = await account("owner", "owner", "Owner");
        await account("member-z", "member", "Bravo");
        await account("member-a", "member", "Charlie");
        await account("member-b", "member", "Delta");
        const first = await page(actor);
        expect(first.items.map((row) => row.accountId)).toEqual([actor, "member-z"]);
        await db.account.delete({ where: { id: "member-z" } });
        // A rank/id-only fallback drops both unchanged members here.
        expect(await allPages(actor, first.nextCursor)).toEqual(["member-a", "member-b"]);
    });
});
