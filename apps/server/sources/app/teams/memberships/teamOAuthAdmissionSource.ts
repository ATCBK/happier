import { z } from "zod/mini";

/** Server-authored authority for one exact Team OAuth admission finalization. */
export const teamOAuthAdmissionSourceSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("team_invitation"), teamId: z.string().check(z.trim(), z.minLength(1)), providerId: z.string().check(z.trim(), z.minLength(1)),
        providerOrigin: z.enum(["home", "team"]),
        connectionId: z.nullable(z.string().check(z.trim(), z.minLength(1))), connectionRevision: z.nullable(z.number().check(z.int(), z.positive())),
        admissionMode: z.literal("invite_only"), invitationId: z.string().check(z.trim(), z.minLength(1)),
        tokenHash: z.string().check(z.regex(/^[0-9a-f]{64}$/u)),
    }),
    z.strictObject({
        kind: z.literal("team_provisioned_identity"), teamId: z.string().check(z.trim(), z.minLength(1)), providerId: z.string().check(z.trim(), z.minLength(1)),
        connectionId: z.string().check(z.trim(), z.minLength(1)), connectionRevision: z.number().check(z.int(), z.positive()),
        admissionMode: z.literal("provisioned"), provisionedIdentityId: z.string().check(z.trim(), z.minLength(1)),
    }),
    z.strictObject({
        kind: z.literal("team_jit_identity"), teamId: z.string().check(z.trim(), z.minLength(1)), providerId: z.string().check(z.trim(), z.minLength(1)),
        connectionId: z.string().check(z.trim(), z.minLength(1)), connectionRevision: z.number().check(z.int(), z.positive()),
        admissionMode: z.literal("jit"), authAttemptId: z.string().check(z.trim(), z.minLength(8), z.maxLength(128)),
    }),
]);

export type TeamOAuthAdmissionSource = z.infer<typeof teamOAuthAdmissionSourceSchema>;
