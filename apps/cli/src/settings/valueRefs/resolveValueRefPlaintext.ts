/**
 * Value ref resolution (CLI/runtime)
 *
 * Resolves settings value references into plaintext strings at runtime:
 * - literal values may include `${VAR}` templates expanded from `processEnv`
 * - savedSecret values use the admitted SavedSecret catalog materializer
 */

import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import type { ValueRefV1, SessionAttestedContextV1 } from '@happier-dev/protocol';
import type {
  SavedSecretMaterializerV1,
  SavedSecretResolutionFailureStatusV1,
} from '@/settings/secrets/savedSecretCatalog';

export {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';

export type ValueRefPlaintextResolution =
  | Readonly<{ status: 'ready'; value: string }>
  | Readonly<{ status: 'literal_unavailable' }>
  | Readonly<{ status: 'session_attested_unavailable' }>
  | Readonly<{ status: SavedSecretResolutionFailureStatusV1 }>;

export function resolveValueRefPlaintext(params: Readonly<{
  valueRef: ValueRefV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  processEnv: NodeJS.ProcessEnv;
  session?: Readonly<{ sessionId: string; attestedContext?: SessionAttestedContextV1 }>;
}>): ValueRefPlaintextResolution {
  if (params.valueRef.t === 'sessionAttested') {
    const value = params.valueRef.field === 'sessionId' ? params.session?.sessionId
      : params.session?.attestedContext?.[params.valueRef.field];
    return typeof value === 'string' && value.length > 0
      ? { status: 'ready', value } : { status: 'session_attested_unavailable' };
  }
  if (params.valueRef.t === 'literal') {
    const expanded = expandEnvironmentVariables({ __VALUE__: params.valueRef.v }, params.processEnv, { warnOnUndefined: false })
      .__VALUE__;
    if (typeof expanded !== 'string') return { status: 'literal_unavailable' };
    if (params.valueRef.v.includes('${') && expanded.includes('${')) return { status: 'literal_unavailable' };
    return { status: 'ready', value: expanded };
  }

  if (!params.savedSecretMaterializer) return { status: 'temporarily_unavailable' };
  const resolved = params.savedSecretMaterializer.resolve(params.valueRef.secretId);
  return resolved.status === 'ready' ? { status: 'ready', value: resolved.value } : resolved;
}
