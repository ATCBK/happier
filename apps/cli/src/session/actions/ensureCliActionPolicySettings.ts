import type { StoredCredentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { initializeTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { runTracedExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';

export async function ensureCliActionPolicySettings(credentials: StoredCredentials | null | undefined, serverHttpBaseUrl?: string): Promise<void> {
  if (!credentials) return;
  // Security and sealed Settings have independent readers. Join both before
  // admission so loading Settings cannot grant authority ahead of security.
  await Promise.all([
    runTracedExternalActionInnerStage('cli.policy_security', () => initializeTerminalPresentUserPolicy({ token: credentials.token, ...(serverHttpBaseUrl ? { serverHttpBaseUrl } : {}) })),
    runTracedExternalActionInnerStage('cli.policy_settings', () => bootstrapAccountSettingsContext({
      credentials,
      // Policy is an admission input: a successful first fetch must publish before
      // prepare/execute can continue. Blocking bootstrap still falls back to the
      // existing cache/default contract when the settings service is unavailable.
      mode: 'blocking',
    })),
  ]);
}
