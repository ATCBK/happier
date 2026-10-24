import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, initDbPostgres } from "@/storage/db";
import { listAutomationDefinitionsPage } from "./automationCrudService";
import { AutomationDefinitionListResponseSchema } from "@happier-dev/protocol/automations/automationApiV3";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAutomationV3Routes } from "@/app/api/routes/automations/registerAutomationV3Routes";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Automation definition demand (PostgreSQL)", () => {
    const definitionIds = [randomUUID(), randomUUID()];
    let accountId: string;
    let otherAccountId: string;
    const selectedIds = [randomUUID(), randomUUID()];

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        accountId = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        otherAccountId = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        const row = (id: string, workflowDefinitionId: string, owner = accountId) => ({ id,
            accountId: owner, workflowDefinitionId, name: "Definition selection fixture", templateCiphertext: "{}" });
        await db.automation.createMany({ data: [
            ...Array.from({ length: 2500 }, () => row(randomUUID(), "builtin:unrelated")),
            ...selectedIds.map((id, index) => row(id, definitionIds[index]!)),
            row(randomUUID(), definitionIds[0]!, otherAccountId),
            { ...row(randomUUID(), definitionIds[0]!), deletedAt: new Date() },
        ] });
    });
    afterAll(async () => {
        if (accountId) await db.account.delete({ where: { id: accountId } });
        if (otherAccountId) await db.account.delete({ where: { id: otherAccountId } });
        await db.$disconnect();
    });

    it("pages only requested definition rows and retains Account and deletion admission", async () => {
        const selection = { accountId, workflowDefinitionIds: definitionIds };
        const rows: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const page = await listAutomationDefinitionsPage({ ...selection, cursor });
            pages += 1;
            rows.push(...page.automations.map(row => row.id));
            cursor = page.nextCursor;
        } while (cursor);
        expect({ rows: rows.length, pages }).toEqual({ rows: 2, pages: 1 });
        expect(rows.sort()).toEqual([...selectedIds].sort());
        const empty = { accountId, workflowDefinitionIds: [] };
        expect(await listAutomationDefinitionsPage(empty)).toEqual({ automations: [], nextCursor: null });
    });

    it("carries set demand through the body-bearing HTTP read without dropping its filter", async () => {
        const app = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        try {
            const demand = [...definitionIds, ...Array.from({ length: 498 }, () => randomUUID())];
            const response = await app.inject({ method: "POST", url: "/v3/automations/query",
                headers: { "x-test-user-id": accountId }, payload: { workflowDefinitionIds: demand } });
            expect(response.statusCode, response.body).toBe(200);
            const page = AutomationDefinitionListResponseSchema.parse(response.json());
            expect(page.automations.map(row => row.id).sort()).toEqual([...selectedIds].sort());
            expect(page.nextCursor).toBeNull();
            const oversized = await app.inject({ method: "POST", url: "/v3/automations/query",
                headers: { "x-test-user-id": accountId }, payload: { workflowDefinitionIds: [...demand, randomUUID()] } });
            expect(oversized.statusCode).toBe(400);
            const denied = await app.inject({ method: "POST", url: "/v3/automations/query",
                headers: { "x-test-user-id": accountId, "x-test-auth-token-kind": "api_token" },
                payload: { workflowDefinitionIds: definitionIds } });
            expect(denied.statusCode).toBe(403);
        } finally { await app.close(); }
    });
});
