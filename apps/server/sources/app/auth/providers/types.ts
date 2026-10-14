import type { FeaturesResponse } from "@/app/features/types";
import type { AuthPolicy } from "@/app/auth/authPolicy";
import type { AuthProviderId } from '@happier-dev/protocol/auth/providers';
import type { TeamIdentityProviderKindV1 } from "@happier-dev/protocol/teams";

export type AuthProviderFeatures = FeaturesResponse["capabilities"]["auth"]["providers"][string];

export type AuthProviderResolver = Readonly<{
    id: AuthProviderId;
    resolveFeatures: (params: { env: NodeJS.ProcessEnv; policy: AuthPolicy }) => AuthProviderFeatures;
    requiresOAuth: boolean;
    isConfigured: (env: NodeJS.ProcessEnv) => boolean;
    /**
     * The catalog identity-provider kind this resolver serves (teams-lane-03/01
     * §10.2). Absent for a built-in OAuth provider that is not a catalog kind.
     */
    providerKind?: TeamIdentityProviderKindV1;
}>;
