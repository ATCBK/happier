import { describe, expect, it } from "vitest";

import { settleQualifiedConnectedAccountCredentialMetadata } from "./credentialMetadataSettlement";

const current = {
    providerIdentity: {
        accountId: "provider-account-1",
        email: "operator@example.com",
    },
    displayName: "Old name",
    scopes: ["account.read"],
};

describe("qualified Connected Account credential metadata settlement", () => {
    it('admits fresh identity attestation after explicitly unknown identity', () => {
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current: { scopes: [], providerIdentity: { accountId: null, email: null, organizationId: null } },
            incoming: { ...current, providerIdentity: { ...current.providerIdentity, organizationId: 'org-a' } },
            allowProviderIdentityChange: false,
        })).toEqual({ status: 'settled', metadata: { ...current,
            providerIdentity: { ...current.providerIdentity, organizationId: 'org-a' } } });
    });

    it('preserves omitted organization context and replaces explicit context without inheriting an old organization', () => {
        const known = { ...current, providerIdentity: { ...current.providerIdentity, organizationId: 'org-a' } };
        for (const [incomingIdentity, expectedOrganization] of [
            [undefined, 'org-a'],
            [{ accountId: current.providerIdentity.accountId, organizationId: 'org-b' }, 'org-b'],
            [{ accountId: current.providerIdentity.accountId }, undefined],
        ] as const) {
            const result = settleQualifiedConnectedAccountCredentialMetadata({
                current: known,
                incoming: { scopes: [], ...(incomingIdentity ? { providerIdentity: incomingIdentity } : {}) },
                allowProviderIdentityChange: false,
            });
            expect(result.status).toBe('settled');
            if (result.status !== 'settled') throw new Error('Expected metadata settlement');
            expect(result.metadata.providerIdentity).toEqual({
                ...current.providerIdentity,
                ...(expectedOrganization ? { organizationId: expectedOrganization } : {}),
            });
        }
    });

    it("preserves established provider identity when reconnect omits it", () => {
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current,
            incoming: {
                displayName: "New name",
                scopes: ["account.read", "account.write"],
            },
            allowProviderIdentityChange: false,
        })).toEqual({
            status: "settled",
            metadata: {
                providerIdentity: current.providerIdentity,
                displayName: "New name",
                scopes: ["account.read", "account.write"],
            },
        });
    });

    it("requires confirmation for explicit identity replacement or loss", () => {
        for (const providerIdentity of [
            { accountId: "provider-account-2" },
            { accountId: null },
            { email: "other@example.com" },
            { email: null },
        ] as const) {
            expect(settleQualifiedConnectedAccountCredentialMetadata({
                current,
                incoming: { providerIdentity, scopes: [] },
                allowProviderIdentityChange: false,
            })).toEqual({ status: "provider_identity_mismatch" });
        }

        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current,
            incoming: {
                providerIdentity: { accountId: "provider-account-2" },
                scopes: [],
            },
            allowProviderIdentityChange: true,
        })).toEqual({
            status: "settled",
            metadata: {
                providerIdentity: {
                    accountId: "provider-account-2",
                    email: "operator@example.com",
                },
                scopes: [],
            },
        });
        expect(settleQualifiedConnectedAccountCredentialMetadata({
            current,
            incoming: {
                providerIdentity: {
                    accountId: null,
                    email: null,
                },
                scopes: [],
            },
            allowProviderIdentityChange: true,
        })).toEqual({
            status: "settled",
            metadata: {
                providerIdentity: {
                    accountId: null,
                    email: null,
                },
                scopes: [],
            },
        });
    });
});
