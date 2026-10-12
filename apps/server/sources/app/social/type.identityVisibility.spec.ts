import { describe, expect, it } from "vitest";

import { buildUserProfile, toSocialIdentities } from "./type";

describe("social identity visibility", () => {
    it("projects a current account name into the released social name fields without splitting it", () => {
        const account = {
            id: "account-1",
            name: "  Ana María de la Cruz  ",
            firstName: "Old",
            lastName: "Identity",
            username: "ana",
            avatar: null,
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        };
        const profile = buildUserProfile(account, "none", [], new Map());
        expect(profile).toMatchObject({ firstName: "Ana María de la Cruz", lastName: null });
        expect(buildUserProfile({ ...account, name: null }, "none", [], new Map()))
            .toMatchObject({ name: null, firstName: "", lastName: null });
    });

    it("omits the native email locator without hiding other native identities", () => {
        expect(toSocialIdentities([
            {
                provider: "email",
                providerLogin: "owner@example.test",
                profile: {},
                showOnProfile: false,
            },
            {
                provider: "mtls",
                providerLogin: null,
                profile: {},
                showOnProfile: false,
            },
            {
                provider: "github",
                providerLogin: "octocat",
                profile: {},
                showOnProfile: true,
            },
        ])).toEqual([
            {
                provider: "mtls",
                providerLogin: null,
                profile: {},
                showOnProfile: false,
            },
            {
                provider: "github",
                providerLogin: "octocat",
                profile: {},
                showOnProfile: true,
            },
        ]);
    });
});
