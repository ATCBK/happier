import { TokenStorage } from '@/auth/storage/tokenStorage';
import { parseToken } from '@/utils/auth/parseToken';
import { listServerProfiles, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

export async function resolveNotificationPermissionTarget(serverUrl: string, accountId?: string | null) {
    const key = createServerUrlComparableKey(serverUrl);
    if (!key) return null;
    const profile = listServerProfiles().find((candidate) => createServerUrlComparableKey(candidate.serverUrl) === key);
    if (!profile) return null;
    const serverId = resolveServerProfileScopeIdForIdentifier(profile.id);
    if (!serverId) return null;
    const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId });
    if (!credentials) return null;
    const scope = createServerAccountScope(serverId, parseToken(credentials.token));
    if (!scope || (accountId && accountId !== scope.accountId)) return null;
    return scope;
}
