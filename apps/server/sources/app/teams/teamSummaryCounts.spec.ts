import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { readTeamSummaryCountsInTx } from "./teamSummaryCounts";

describe("Team summary Group counts", () => {
    it("counts zero, archived, and restored Groups in the same grouped read", async () => {
        const groupBy = vi.fn().mockResolvedValue([]);
        // Prisma is the database boundary; no database is opened in this lane.
        const tx = {
            $queryRawUnsafe: vi.fn().mockResolvedValue([{ milliseconds: 1_000 }]),
            teamMembership: { groupBy: vi.fn().mockResolvedValue([]) },
            teamGroup: { groupBy },
            teamInvitation: { groupBy: vi.fn().mockResolvedValue([]) },
        } as unknown as Tx;
        const read = async () => (await readTeamSummaryCountsInTx(tx, ["team"])).get("team");
        expect(await read()).toMatchObject({ groups: 0, archivedGroups: 0 });

        groupBy.mockResolvedValue([{ teamId: "team", archivedAt: new Date(500), _count: { _all: 1 } }]);
        expect(await read()).toMatchObject({ groups: 0, archivedGroups: 1 });

        groupBy.mockResolvedValue([{ teamId: "team", archivedAt: null, _count: { _all: 1 } }]);
        expect(await read()).toMatchObject({ groups: 1, archivedGroups: 0 });
        // The storage query must include both states; excluding archived rows would hide the control.
        expect(groupBy.mock.lastCall?.[0]).toMatchObject({
            by: ["teamId", "archivedAt"], where: { teamId: { in: ["team"] } },
        });
        expect(groupBy.mock.lastCall?.[0].where).not.toHaveProperty("archivedAt");
    });
});
