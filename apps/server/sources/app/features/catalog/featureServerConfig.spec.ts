import { FEATURE_CATALOG, readServerConfig } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { FEATURE_ENV_KEYS } from './featureEnvSchema';
import { FEATURE_CONFIG, FEATURE_SERVER_CONFIG } from './featureServerConfig';

describe('FEATURE_SERVER_CONFIG', () => {
  it('declares every FEATURE_ENV_KEYS key exactly once', () => {
    expect(FEATURE_SERVER_CONFIG.map((entry) => entry.key).sort()).toEqual(Object.values(FEATURE_ENV_KEYS).sort());
  });

  it('links a catalog switch to its feature, family and catalog description', () => {
    expect(FEATURE_CONFIG.sessionsDraftsEnabled).toMatchObject({
      key: 'HAPPIER_FEATURE_SESSIONS_DRAFTS__ENABLED',
      featureId: 'sessions.drafts',
      family: 'sessions',
      section: 'features',
      description: FEATURE_CATALOG['sessions.drafts'].description,
      editable: 'home',
      apply: 'live',
    });
    expect(FEATURE_CONFIG.encryptionStoragePolicy).toMatchObject({ section: 'policies', editable: 'home' });
    expect(FEATURE_SERVER_CONFIG.some((entry) => entry.key === 'HAPPIER_FEATURE_SESSIONS_FOLDERS__ENABLED')).toBe(false);
  });

  it('marks keys captured when the server starts as restart-to-apply, and key material as secret', () => {
    expect(FEATURE_CONFIG.machinesTunnelServerRoutedEnabled.apply).toBe('restart');
    expect(FEATURE_CONFIG.petsSyncMaxManifestBytes.apply).toBe('restart');
    expect(FEATURE_CONFIG.peerMediationRouteGrantSigningPrivateKey.sensitivity).toBe('secret');
  });

  it('reads a legacy alias when the key itself is unset', () => {
    expect(readServerConfig({ AUTH_RECOVERY_PROVIDER_RESET_ENABLED: 'false' }, FEATURE_CONFIG.authRecoveryProviderResetEnabled)).toBe(false);
  });
});
