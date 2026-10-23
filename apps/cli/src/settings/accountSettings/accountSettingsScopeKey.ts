import { createHash } from 'node:crypto';

import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAccountSettingsCachePath } from './accountSettingsCache';

function accountScopeKey(token: string): string {
  const accountId = readAccountIdFromToken(token);
  // Bearer rotation does not retire an Account. Opaque credentials cannot
  // establish that continuity, so keep their existing credential isolation.
  const identity = accountId ? `account:${accountId}` : `token:${token}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

export function createAccountSettingsScopeKey(params: Readonly<{
  cachePath: string;
  token: string;
}>): string {
  return `${params.cachePath}::${accountScopeKey(params.token)}`;
}

/**
 * Shared Account/Home publication scope for settings-backed host consumers
 * that only have the authenticated token available. The active snapshot owner
 * separately fences lifetime and key-material retirement.
 */
export function resolveAccountSettingsScopeKeyForToken(token: string): string {
  return createAccountSettingsScopeKey({
    cachePath: resolveAccountSettingsCachePath({ token }),
    token,
  });
}

export function resolveAccountSettingsScopeKey(credentials: StoredCredentials): string {
  return resolveAccountSettingsScopeKeyForToken(credentials.token);
}
