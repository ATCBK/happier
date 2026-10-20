import { z } from "zod/mini";
import { IdentityConnectionTestDiagnosticsV1Schema, type IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol/identity/testDiagnostics';

import type { Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { oauthSecurityBindingSchema, type OAuthSecurityBinding } from "./oauthExternalSchemas";

const identityConnectionTestResultSchema = z.strictObject({
    v: z.literal(1),
    purpose: z.literal("identity_connection_test"),
    initiatorAccountId: z.string().check(z.trim(), z.minLength(1)),
    securityBinding: oauthSecurityBindingSchema.check(z.refine((binding) => binding.purpose === "identity_connection_test", { message: "Expected identity-connection test binding" })),
    providerUserId: z.string().check(z.minLength(1), z.maxLength(1024)),
    // A provider that supplies no sanitized evidence, and any result written before
    // diagnostics existed, simply omits this field.
    diagnostics: z.optional(IdentityConnectionTestDiagnosticsV1Schema),
    testedAt: z.string().check(z.iso.datetime()),
});

export type IdentityConnectionTestResult = Readonly<{
    initiatorAccountId: string;
    securityBinding: OAuthSecurityBinding;
    providerUserId: string;
    diagnostics: IdentityConnectionTestDiagnosticsV1 | null;
    testedAt: Date;
}>;

function resultKey(resultHandle: string): string {
    return `oauth_identity_connection_test_result_${resultHandle.trim()}`;
}

export async function createIdentityConnectionTestResult(input: Readonly<{
    initiatorAccountId: string;
    securityBinding: OAuthSecurityBinding;
    providerUserId: string;
    diagnostics?: IdentityConnectionTestDiagnosticsV1 | null;
    testedAt: Date;
    expiresAt: Date;
}>): Promise<Readonly<{ resultHandle: string; key: string }>> {
    if (input.securityBinding.purpose !== "identity_connection_test") {
        throw new Error("identity_connection_test_invalid");
    }
    if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()) {
        throw new Error("identity_connection_test_invalid");
    }
    const value = identityConnectionTestResultSchema.parse({
        v: 1,
        purpose: "identity_connection_test",
        initiatorAccountId: input.initiatorAccountId,
        securityBinding: input.securityBinding,
        providerUserId: input.providerUserId,
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
        testedAt: input.testedAt.toISOString(),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const resultHandle = randomKeyNaked(24);
        const key = resultKey(resultHandle);
        try {
            await db.repeatKey.create({
                data: { key, value: JSON.stringify(value), expiresAt: input.expiresAt },
            });
            return { resultHandle, key };
        } catch {
            // Retry only with a fresh opaque handle; no result bytes or provider evidence change.
        }
    }
    throw new Error("identity_connection_test_unavailable");
}

export async function consumeIdentityConnectionTestResultInTx(
    tx: Tx,
    input: Readonly<{ resultHandle: string; initiatorAccountId: string }>,
): Promise<IdentityConnectionTestResult | null> {
    const key = resultKey(input.resultHandle);
    if (key.endsWith("_result_")) return null;
    const row = await tx.repeatKey.findUnique({ where: { key } });
    if (!row) return null;
    const consumed = await tx.repeatKey.deleteMany({
        where: { key: row.key, value: row.value },
    });
    if (consumed.count !== 1 || row.expiresAt.getTime() <= Date.now()) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(row.value);
    } catch {
        return null;
    }
    const parsed = identityConnectionTestResultSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.initiatorAccountId !== input.initiatorAccountId) return null;
    return {
        initiatorAccountId: parsed.data.initiatorAccountId,
        securityBinding: parsed.data.securityBinding,
        providerUserId: parsed.data.providerUserId,
        diagnostics: parsed.data.diagnostics ?? null,
        testedAt: new Date(parsed.data.testedAt),
    };
}
