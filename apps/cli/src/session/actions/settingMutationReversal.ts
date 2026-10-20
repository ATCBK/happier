import type { z } from 'zod/mini';
import type { AccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { SettingsDeclarationActionInputSchemasV1, SettingsDeclarationMutationReversalV1Schema, SettingsDeclarationValueV1Schema, type SettingsDeclarationResetExpectedV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import type { PortableSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { captureSettingMutationV1, restoreSettingMutationV1 } from '@happier-dev/protocol/actions/settings/settingMutationReversal';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAccountSettingsV2Raw, updateAccountSettingsV2Once, updateAccountSettingsV2WithRetry } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';

const refuse = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
class SettingReversalRefused extends Error {
  constructor(readonly errorCode: 'credential_scope_retired' | 'account_settings_conflict' | 'invalid_setting_value') { super(errorCode); }
}

/** Exact receipts borrow the ordinary declaration producer and the Account writer's CAS. */
export async function executeCliSettingMutationReversal(params: Readonly<{
  declaration: PortableSettingDeclarationV1;
  requested: z.output<typeof SettingsDeclarationActionInputSchemasV1['settings.set']>;
  resetExpected?: SettingsDeclarationResetExpectedV1;
  credentials: StoredCredentials;
  serverId?: string;
  signal?: AbortSignal;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  prepareMutation: (raw: Readonly<Record<string, unknown>>) => Promise<AccountSettingMutationV1>;
  readValue: (settings: Readonly<Record<string, unknown>>) => unknown;
}>) {
  const { declaration, requested } = params;
  const accountId = readAccountIdFromToken(params.credentials.token);
  const reversal = params.resetExpected === undefined ? requested.reversal : { kind: 'reset' as const, expected: params.resetExpected };
  if (!reversal || declaration.storage?.scope !== 'account' || !params.serverId || !accountId) return refuse('setting_conditional_mutation_unsupported');
  const scope = { serverId: params.serverId, accountId };
  if (reversal.kind === 'restore' && !sameStrictJsonValue(scope, reversal.scope)) return refuse('setting_reversal_scope_mismatch');
  const assertCurrent = async () => {
    params.signal?.throwIfAborted();
    if (params.isCredentialCurrent && !await params.isCredentialCurrent()) throw new SettingReversalRefused('credential_scope_retired');
  };
  let result: Awaited<ReturnType<typeof updateAccountSettingsV2WithRetry>>;
  let receipt: unknown;
  try {
    await assertCurrent();
    if (reversal.kind === 'restore' || reversal.kind === 'reset') {
      const restore = async (raw: Readonly<Record<string, unknown>>) => {
        await assertCurrent();
        const mutation = await params.prepareMutation(raw);
        const restored = restoreSettingMutationV1(raw, mutation, reversal, params.readValue);
        if (restored.status !== 'prepared') throw new SettingReversalRefused(restored.status === 'conflict' ? 'account_settings_conflict' : 'invalid_setting_value');
        return restored.mutation;
      };
      result = requested.expectedSettingsVersion === undefined
        ? await updateAccountSettingsV2WithRetry({ credentials: params.credentials, prepareMutation: restore, signal: params.signal })
        : await updateAccountSettingsV2Once({ credentials: params.credentials, expectedVersion: requested.expectedSettingsVersion,
          prepareMutation: restore, signal: params.signal });
    } else {
      const snapshot = await readAccountSettingsV2Raw({ credentials: params.credentials, signal: params.signal });
      await assertCurrent();
      const mutation = await params.prepareMutation(snapshot.raw);
      const captured = captureSettingMutationV1(snapshot.raw, mutation);
      if (!captured) return refuse('invalid_setting_value');
      result = await updateAccountSettingsV2Once({ credentials: params.credentials,
        expectedVersion: requested.expectedSettingsVersion ?? snapshot.version,
        prepareMutation: async raw => {
          await assertCurrent();
          if (!sameStrictJsonValue(captureSettingMutationV1(raw, await params.prepareMutation(raw)), captured)) throw new SettingReversalRefused('account_settings_conflict');
          return mutation;
        }, signal: params.signal });
      receipt = { scope, beforeVersion: snapshot.version, appliedVersion: 'version' in result ? result.version : undefined, ...captured };
    }
  } catch (error) {
    if (error instanceof SettingReversalRefused) return refuse(error.errorCode);
    throw error;
  }
  if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'satisfied') return { ...refuse(`account_settings_${result.status}`), details: result };
  const projected = params.readValue(result.settings);
  const response = { anchor: declaration.anchor,
    ...(projected === undefined ? { unset: true as const } : { value: SettingsDeclarationValueV1Schema.parse(projected) }), settingsVersion: result.version };
  if (reversal.kind === 'restore' || reversal.kind === 'reset') return response;
  if (result.status === 'unchanged') return { ...response, reversalUnavailableReason: 'no_change' as const };
  const parsed = SettingsDeclarationMutationReversalV1Schema.safeParse(receipt);
  return parsed.success ? { ...response, reversal: parsed.data } : response;
}
