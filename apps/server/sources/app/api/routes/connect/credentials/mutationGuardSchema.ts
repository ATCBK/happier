import { z } from "zod/mini";

export const connectedServiceCredentialMutationGuardFields = {
    expectedCredentialRevision: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(128)))),
    refreshLeaseOwnerId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
} as const;

export function validateConnectedServiceCredentialMutationGuard(
    value: Readonly<{ expectedCredentialRevision?: string | null; refreshLeaseOwnerId?: string }>,
    context: z.core.$RefinementCtx,
): void {
    if (value.refreshLeaseOwnerId && typeof value.expectedCredentialRevision !== "string") {
        context.addIssue({
            code: "custom",
            message: "refreshLeaseOwnerId requires expectedCredentialRevision",
            path: ["expectedCredentialRevision"],
        });
    }
}
