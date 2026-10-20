import { z } from "zod/mini";
import { computeCanonicalDomainSeparatedDigest } from "@happier-dev/protocol/crypto/canonicalDigest";

const ExactExternalIdSchema = z.string().check(z.minLength(1), z.maxLength(512));
const TeamDirectoryBindingConfigV1Schema = z.discriminatedUnion("kind", [
    z.strictObject({
        v: z.literal(1),
        kind: z.literal("workos_directory"),
        workosDirectoryId: z.string().check(z.minLength(1), z.maxLength(256)),
    }),
    z.strictObject({
        v: z.literal(1),
        kind: z.literal("github_organization"),
        githubOrganizationLogin: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    }),
]);

export type TeamDirectoryBindingConfigV1 = z.infer<typeof TeamDirectoryBindingConfigV1Schema>;

export function parseTeamDirectoryBindingConfigV1(value: unknown): TeamDirectoryBindingConfigV1 {
    return TeamDirectoryBindingConfigV1Schema.parse(value);
}

function deriveExternalSourceKey(kind: TeamDirectoryBindingConfigV1["kind"], parts: readonly string[]): string {
    for (const part of parts) ExactExternalIdSchema.parse(part);
    return `${kind}:${computeCanonicalDomainSeparatedDigest(`happier.${kind}.source.v1`, parts)}`;
}

export function deriveWorkosDirectoryExternalSourceKey(params: Readonly<{
    organizationId: string;
    directoryId: string;
}>): string {
    return deriveExternalSourceKey("workos_directory", [params.organizationId, params.directoryId]);
}

export function deriveGithubDirectoryExternalSourceKey(params: Readonly<{
    registrationId: string;
    installationId: bigint;
    organizationId: bigint;
}>): string {
    return deriveExternalSourceKey("github_organization", [
        params.registrationId,
        params.installationId.toString(),
        params.organizationId.toString(),
    ]);
}
