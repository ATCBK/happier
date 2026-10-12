import { describe, expect, it } from "vitest";
import type { Tx } from "@/storage/inTx";
import { readRunnerConsentDisplayFactsInTx } from "./runnerConsentDisplayFacts";

describe("runner consent display facts", () => {
    it("uses the Account name without reviving a cleared name from legacy identity fields", async () => {
        const account = {
            id: "requester-1",
            name: "  Ana María de la Cruz  ",
            firstName: "Old",
            lastName: "Identity",
            username: "ana",
            avatar: null,
        };
        // The transaction client is the database boundary; presentation logic stays real.
        const tx = {
            account: { findUnique: async () => account },
            team: { findUnique: async () => ({ name: "Engineering" }) },
        } as unknown as Tx;
        const input = { tx, creatorAccountId: account.id, teamId: "team-1", homeServerIdentityId: "home-1" };
        expect((await readRunnerConsentDisplayFactsInTx(input))?.requesterName).toBe("Ana María de la Cruz");
        account.name = "";
        expect((await readRunnerConsentDisplayFactsInTx(input))?.requesterName).toBe("ana");
    });
});
