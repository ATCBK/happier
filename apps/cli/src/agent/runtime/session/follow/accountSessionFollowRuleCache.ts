import axios from 'axios';
import { ListSessionFollowRulesResponseV1Schema, SESSION_FOLLOW_RULES_ROUTE_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { createAutomationAccountEncryptionMaterialSnapshotV1, isAvailableE2eeAutomationAccountEncryptionV1, resolveValidatedAutomationAccountEncryptionV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { StoredCredentials } from '@/persistence';
import { createSessionFollowRuleCache } from './sessionFollowRuleCache';
import { SESSION_FOLLOW_HTTP_PATHS_V1, SessionAutoFollowPreferencesResponseSchema } from '@happier-dev/protocol/sessions/follow/api';

/** Own-Account transport captured by the daemon; restricted Session credentials never enter this reader. */
export function createAccountSessionFollowRuleCache(input: Readonly<{
  accountId: string; credentials: StoredCredentials; serverHttpBaseUrl: string; signal: AbortSignal;
  isCurrent: () => boolean | Promise<boolean>; subscribeInvalidation: (listener: () => void) => () => void;
}>) {
  if (readAccountIdFromToken(input.credentials.token) !== input.accountId) throw new Error('follow_rule_account_mismatch');
  const cache = createSessionFollowRuleCache({
    signal: input.signal, isCurrent: () => !input.signal.aborted, subscribeInvalidation: input.subscribeInvalidation,
    read: async () => {
      if (!await input.isCurrent()) return null;
      const encryption = await resolveValidatedAutomationAccountEncryptionV1({ signal: input.signal,
        resolveAccountEncryptionCurrentness: async signal => await fetchAccountEncryptionCurrentness({
          token: input.credentials.token, serverBaseUrl: input.serverHttpBaseUrl, signal,
        }),
        resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(input.credentials),
      });
      if (encryption.kind !== 'available' || !await input.isCurrent()) return null;
      const options = {
        headers: { Authorization: `Bearer ${input.credentials.token}` }, signal: input.signal, validateStatus: () => true,
      };
      const [response, defaultsResponse] = await Promise.all([
        axios.get<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_RULES_ROUTE_V1}`, options),
        axios.get<unknown>(`${input.serverHttpBaseUrl}${SESSION_FOLLOW_HTTP_PATHS_V1.preferences}`, options),
      ]);
      if (response.status !== 200 || defaultsResponse.status !== 200 || !await input.isCurrent()) return null;
      const parsed = ListSessionFollowRulesResponseV1Schema.safeParse(response.data);
      const defaults = SessionAutoFollowPreferencesResponseSchema.safeParse(defaultsResponse.data);
      if (!parsed.success || !defaults.success) return null;
      return { mode: encryption.witness.mode,
        material: isAvailableE2eeAutomationAccountEncryptionV1(encryption) ? encryption.material.material : null,
        rules: parsed.data.rules, defaultPreferences: defaults.data };
    },
  });
  return {
    async read(options?: Parameters<typeof cache.read>[0]) {
      try {
        if (input.signal.aborted || !await input.isCurrent()) return { status: 'unavailable', reason: 'account-retired' } as const;
        return await cache.read(options, input.isCurrent);
      } catch { return { status: 'unavailable', reason: 'account-retired' } as const; }
    },
    async hasEnabledSessionReceiver(sessionId: string): Promise<boolean> {
      try { return await cache.hasEnabledSessionReceiver(sessionId, input.isCurrent); }
      catch { return false; }
    },
    dispose: cache.dispose,
  };
}
