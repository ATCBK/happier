import { describe, expect, it } from "vitest";

import { normalizeAndValidateWorkosProfile } from "./normalizeAndValidateWorkosProfile";

const expectedBinding = Object.freeze({
    organizationId: "org_01HAPPIER",
    connectionId: "conn_01HAPPIER",
});

describe("normalizeAndValidateWorkosProfile", () => {
    it("returns only bounded identity and correlation fields for the exact binding", () => {
        const result = normalizeAndValidateWorkosProfile({
            profile: {
                id: "prof_01HAPPIER",
                idpId: "00u-external-user",
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                connectionType: "SAML",
                email: "  Alice@Example.COM ",
                name: "Alice Example",
                roles: [{ slug: "admin" }],
                groups: ["owners"],
                customAttributes: { authority: true },
                rawAttributes: { sensitive: "discard-me" },
            },
            expectedBinding,
        });

        expect(result).toEqual({
            ok: true,
            value: {
                id: "prof_01HAPPIER",
                idpId: "00u-external-user",
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                email: "alice@example.com",
                name: "Alice Example",
            },
        });
        expect(JSON.stringify(result)).not.toContain("owners");
        expect(JSON.stringify(result)).not.toContain("discard-me");
        expect(JSON.stringify(result)).not.toContain("admin");
    });

    it('joins provider-given parts only at ingest and preserves a full name once normalized', () => {
        const result = normalizeAndValidateWorkosProfile({
            profile: { id: 'prof', email: 'alice@example.test', ...expectedBinding,
                firstName: '  Alice ', lastName: ' Example  ' }, expectedBinding,
        });
        expect(result).toMatchObject({ ok: true, value: { name: 'Alice Example' } });
    });

    it("accepts a missing IdP correlation value without inventing one", () => {
        expect(normalizeAndValidateWorkosProfile({
            profile: {
                id: "prof_01HAPPIER",
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                email: "alice@example.com",
            },
            expectedBinding,
        })).toEqual({
            ok: true,
            value: {
                id: "prof_01HAPPIER",
                idpId: null,
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                email: "alice@example.com",
            },
        });
    });

    it.each([
        [{ id: "", organizationId: expectedBinding.organizationId, connectionId: expectedBinding.connectionId, email: "alice@example.com" }, "invalid_profile"],
        [{ id: "prof", organizationId: expectedBinding.organizationId, connectionId: expectedBinding.connectionId, email: "not-an-email" }, "invalid_profile"],
        [{ id: "prof", idpId: " ", organizationId: expectedBinding.organizationId, connectionId: expectedBinding.connectionId, email: "alice@example.com" }, "invalid_profile"],
        [{ id: "prof", organizationId: "org_other", connectionId: expectedBinding.connectionId, email: "alice@example.com" }, "workos_organization_mismatch"],
        [{ id: "prof", organizationId: ` ${expectedBinding.organizationId}`, connectionId: expectedBinding.connectionId, email: "alice@example.com" }, "workos_organization_mismatch"],
        [{ id: "prof", organizationId: expectedBinding.organizationId, connectionId: "conn_other", email: "alice@example.com" }, "workos_connection_mismatch"],
        [{ id: "prof", organizationId: expectedBinding.organizationId, connectionId: `${expectedBinding.connectionId} `, email: "alice@example.com" }, "workos_connection_mismatch"],
    ] as const)("rejects invalid or mismatched profile evidence %#", (profile, error) => {
        expect(normalizeAndValidateWorkosProfile({ profile, expectedBinding })).toEqual({ ok: false, error });
    });

    it("rejects oversized correlation values", () => {
        expect(normalizeAndValidateWorkosProfile({
            profile: {
                id: "prof",
                idpId: "x".repeat(513),
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                email: "alice@example.com",
            },
            expectedBinding,
        })).toEqual({ ok: false, error: "invalid_profile" });
        expect(normalizeAndValidateWorkosProfile({
            profile: {
                id: "x".repeat(513),
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                email: "alice@example.com",
            },
            expectedBinding,
        })).toEqual({ ok: false, error: "invalid_profile" });
        expect(normalizeAndValidateWorkosProfile({
            profile: {
                id: "prof",
                organizationId: expectedBinding.organizationId,
                connectionId: expectedBinding.connectionId,
                email: `${"e".repeat(308)}@example.test`,
            },
            expectedBinding,
        })).toEqual({ ok: false, error: "invalid_profile" });
    });
});
