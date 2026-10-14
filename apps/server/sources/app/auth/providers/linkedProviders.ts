import { describeLinkedIdsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { isAccountIdentityEligibleForGenericPresentation } from "@/app/auth/methods/registry";
import type { Tx } from "@/storage/inTx";
import type { LinkedProvider } from '@happier-dev/protocol/account/profile';

export type { LinkedProvider } from '@happier-dev/protocol/account/profile';

interface LinkedIdentityPresentationRow {
    accountId: string;
    provider: string;
    providerLogin: string | null;
    profile: unknown;
    showOnProfile: boolean;
}

function projectLinkedProvider(
    identity: Omit<LinkedIdentityPresentationRow, "accountId">,
    presentation: Awaited<ReturnType<typeof describeLinkedIdsInTx>>,
): LinkedProvider {
    const providerId = identity.provider.toString().trim().toLowerCase();
    const providerLogin = identity.providerLogin ?? null;
    const provider = presentation.get(providerId);
    const extracted = provider?.extractLinkedProvider
        ? provider.extractLinkedProvider({ profile: identity.profile, providerLogin })
        : { displayName: null, avatarUrl: null, profileUrl: null };

    return {
        id: providerId,
        login: providerLogin,
        displayName: extracted.displayName,
        avatarUrl: extracted.avatarUrl,
        profileUrl: extracted.profileUrl,
        showOnProfile: Boolean(identity.showOnProfile),
    };
}

export async function fetchLinkedProvidersForAccounts(params: {
    tx: Tx;
    accountIds: readonly string[];
}): Promise<ReadonlyMap<string, LinkedProvider[]>> {
    const accountIds = [...new Set(params.accountIds)].sort();
    const linkedProvidersByAccountId = new Map<string, LinkedProvider[]>(
        accountIds.map((accountId) => [accountId, []]),
    );
    if (accountIds.length === 0) return linkedProvidersByAccountId;

    const identities = (await params.tx.accountIdentity.findMany({
        where: { accountId: { in: accountIds } },
        select: { accountId: true, provider: true, providerLogin: true, profile: true, showOnProfile: true },
        orderBy: [{ accountId: "asc" }, { provider: "asc" }],
    })).filter((identity) => isAccountIdentityEligibleForGenericPresentation(process.env, identity.provider));
    const presentation = await describeLinkedIdsInTx(params.tx, {
        env: process.env,
        providerIds: identities.map((identity) => identity.provider),
    });

    for (const identity of identities) {
        linkedProvidersByAccountId.get(identity.accountId)?.push(projectLinkedProvider(identity, presentation));
    }
    return linkedProvidersByAccountId;
}

export async function fetchLinkedProvidersForAccount(params: {
    tx: Tx;
    accountId: string;
}): Promise<LinkedProvider[]> {
    const linkedProvidersByAccountId = await fetchLinkedProvidersForAccounts({
        tx: params.tx,
        accountIds: [params.accountId],
    });
    return linkedProvidersByAccountId.get(params.accountId) ?? [];
}
