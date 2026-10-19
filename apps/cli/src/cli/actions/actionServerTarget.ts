import type { StoredCredentials } from '@/persistence';
import { refreshServerProfileHomeConnectionDescriptor, resolveServerProfileHomeIdentityId, type ServerProfile } from '@/server/serverProfiles';
import { configuration } from '@/configuration';
import { ACTION_CLI_SERVER_ID_FLAG } from './parseCommandInput';

export { ACTION_CLI_SERVER_ID_FLAG } from './parseCommandInput';

export type ActionCliCredentialTargetDeps = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  readCredentialsForServerIdFn: (serverId: string) => Promise<StoredCredentials | null>;
  getServerProfileFn: (serverId: string) => Promise<ServerProfile>;
}>;

export type ActionCliFixedServerTarget = Readonly<{
  /** Device-local routing/credential profile; portable Home records use serverIdentityId. */
  serverId: string;
  /** Stable identity observed from the exact Home endpoint; never inferred from the profile id. */
  serverIdentityId?: string;
  serverApiUrl: string;
}>;

/** Reads one CLI Action Home selector without treating bytes after `--` as options. */
export function readActionCliServerId(argv: readonly string[], acceptsServerId: boolean): string | null {
  if (!acceptsServerId) return null;
  let selected: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    let value: string | null = null;
    if (token === ACTION_CLI_SERVER_ID_FLAG) {
      const next = argv[index + 1];
      if (typeof next !== 'string' || next.startsWith('--')) {
        throw Object.assign(new Error(`Option ${ACTION_CLI_SERVER_ID_FLAG} requires a value.`), { code: 'invalid_arguments' });
      }
      value = next.trim();
      index += 1;
    } else if (token.startsWith(`${ACTION_CLI_SERVER_ID_FLAG}=`)) {
      value = token.slice(ACTION_CLI_SERVER_ID_FLAG.length + 1).trim();
    }
    if (value === null) continue;
    if (!value) {
      throw Object.assign(new Error(`Option ${ACTION_CLI_SERVER_ID_FLAG} requires a value.`), { code: 'invalid_arguments' });
    }
    if (selected !== null) {
      throw Object.assign(new Error(`Provide ${ACTION_CLI_SERVER_ID_FLAG} once.`), { code: 'invalid_arguments' });
    }
    selected = value;
  }
  return selected;
}

/**
 * Resolves credentials and endpoint as one qualified Home target. Callers may
 * parse argv differently, but none may pair an explicit URL with ambient Home
 * identity or independently reinterpret exact profile identity.
 */
export async function resolveActionCliCredentialTarget(params: Readonly<{
  requestedServerId: string | null;
  requireServerIdentityId?: boolean;
  deps: ActionCliCredentialTargetDeps;
}>): Promise<Readonly<{
  credentials: StoredCredentials | null;
  fixedServer: ActionCliFixedServerTarget | null;
  serverIdentityId?: string;
}>> {
  const prepareProfile = async (profile: ServerProfile | null, credentials: StoredCredentials | null): Promise<ServerProfile | null> => {
    if (!profile || !credentials || profile.homeConnectionDescriptorAuthority === 'exact' && profile.homeConnectionDescriptor) return profile;
    // Restored identities can have credentials and a URL-only profile. Establish
    // its binding at the existing authenticated descriptor owner before Actions
    // apply their saved-Home currentness checks.
    const refreshed = await refreshServerProfileHomeConnectionDescriptor({ profileId: profile.id,
      serverUrl: profile.localServerUrl ?? profile.serverUrl, token: credentials.token,
    }).catch(() => 'unavailable' as const);
    return refreshed === 'unavailable' ? profile : await params.deps.getServerProfileFn(profile.id);
  };
  if (params.requestedServerId === null) {
    const credentials = await params.deps.readCredentialsFn();
    const profile = await prepareProfile(await params.deps.getServerProfileFn(configuration.activeServerId).catch(() => null), credentials);
    const serverIdentityId = profile ? await resolveServerProfileHomeIdentityId(profile.id) ?? undefined : undefined;
    return { credentials, fixedServer: null,
      ...(serverIdentityId ? { serverIdentityId } : {}) };
  }
  const selectedProfile = await params.deps.getServerProfileFn(params.requestedServerId);
  const credentials = await params.deps.readCredentialsForServerIdFn(selectedProfile.id);
  const profile = await prepareProfile(selectedProfile, credentials) ?? selectedProfile;
  const serverIdentityId = await resolveServerProfileHomeIdentityId(profile.id) ?? undefined;
  if (params.requireServerIdentityId && !serverIdentityId) {
    throw Object.assign(
      new Error(`Saved Home "${profile.id}" has no verified server identity. Re-add or refresh it before retrying.`),
      { code: 'server_identity_unavailable' },
    );
  }
  return {
    credentials,
    ...(serverIdentityId ? { serverIdentityId } : {}),
    fixedServer: {
      serverId: profile.id,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      serverApiUrl: profile.localServerUrl ?? profile.serverUrl,
    },
  };
}
