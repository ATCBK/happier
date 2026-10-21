import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

type Attribution = Extract<AgentSessionRuntimeEvent, { kind: 'usage-observed' }>['attribution'];

export function isCodexRequestUsageIdentityContradicted(
  identity: Readonly<{ providerAccountId: string }> | null,
  liveAccount: Readonly<{ providerAccountId: string | null }> | null,
): boolean {
  return Boolean(identity && liveAccount?.providerAccountId
    && identity.providerAccountId !== liveAccount.providerAccountId);
}

export function resolveCodexRequestUsageAttribution(input: Readonly<{
  turnId: string;
  service: Readonly<{ pluginId: string; localId: string }> | undefined;
  requestIdentity: Readonly<{ profileId: string }> | null;
  accountScope?: 'personal' | 'workspace';
  scope: 'turn_delta' | 'session_cumulative' | 'session_final';
  matchesNativeAttempt: boolean;
}>): Attribution {
  if (!input.service || !input.requestIdentity || input.scope !== 'turn_delta' || !input.matchesNativeAttempt) return undefined;
  return { v: 1, turnId: input.turnId, source: { kind: 'native', ...(input.accountScope ? { accountScope: input.accountScope } : {}), connectedAccount: {
    service: { ...input.service }, accountId: input.requestIdentity.profileId,
  } } };
}
