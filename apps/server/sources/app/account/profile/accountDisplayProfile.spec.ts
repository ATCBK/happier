import { describe, expect, it } from "vitest";
import { initFilesLocalFromEnv } from "@/storage/blob/files";

// Configure the real local URL owner without opening or writing any files.
initFilesLocalFromEnv({ PUBLIC_URL: "https://files.test" });

const {
    projectAccountDisplayProfileV1,
    toShareUserProfile,
} = await import("./accountDisplayProfile");

const BASE = {
    id: "acc_alice",
    name: "Captain",
    firstName: "Alice",
    lastName: "Chen",
    username: "alice",
    avatar: { path: "avatars/alice.png", width: 1, height: 1, thumbhash: "x" },
};

describe("accountDisplayProfile", () => {
    it("projects the neutral display profile with a public avatar URL and no Account id", () => {
        const projected = projectAccountDisplayProfileV1(BASE);
        expect(projected).toEqual({
            name: "Captain",
            firstName: "Captain",
            lastName: null,
            username: "alice",
            avatarUrl: "https://files.test/files/avatars/alice.png",
        });
        expect(projected).not.toHaveProperty("id");
    });

    it("degrades malformed or absent avatar data to a null URL instead of leaking raw storage state", () => {
        for (const avatar of [null, undefined, {}, { path: 42 }, "avatars/alice.png", []]) {
            expect(projectAccountDisplayProfileV1({ ...BASE, avatar }).avatarUrl).toBeNull();
        }
    });

    it("keeps absent names null rather than substituting an identifier", () => {
        expect(projectAccountDisplayProfileV1({
            id: "acc_ghost",
            name: null,
            firstName: null,
            lastName: null,
            username: null,
            avatar: null,
        })).toEqual({ name: null, firstName: null, lastName: null, username: null, avatarUrl: null });
    });

    it("keeps the released direct-share wire shape, including its Account id field", () => {
        expect(toShareUserProfile(BASE)).toEqual({
            id: "acc_alice",
            firstName: "Captain",
            lastName: null,
            username: "alice",
            avatar: "https://files.test/files/avatars/alice.png",
        });
    });
});
