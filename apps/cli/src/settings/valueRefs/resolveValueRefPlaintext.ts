/**
 * Value ref resolution (CLI/runtime)
 *
 * Resolves settings value references into plaintext strings at runtime:
 * - literal values may include `${VAR}` templates expanded from `processEnv`
 * - savedSecret values use the admitted SavedSecret catalog materializer
 */

import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { resolveValueRefPlaintextV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import type { ValueRefV1, SessionAttestedContextV1 } from '@happier-dev/protocol';
import type {
  SavedSecretMaterializerV1,
  SavedSecretResolutionFailureStatusV1,
} from '@/settings/secrets/savedSecretCatalog';

export type ValueRefPlaintextResolution =
  | Readonly<{ status: 'ready'; value: string }>
  | Readonly<{ status: 'literal_unavailable' }>
  | Readonly<{ status: 'session_attested_unavailable' }>
  | Readonly<{ status: SavedSecretResolutionFailureStatusV1; reference: string }>;

function resolveSavedSecretValue(secretId: string, materializer: SavedSecretMaterializerV1 | undefined) {
  if (!materializer) return { status: 'temporarily_unavailable' as const, reference: secretId };
  const resolved = materializer.resolve(secretId);
  return resolved.status === 'ready'
    ? { status: 'ready' as const, value: resolved.value }
    : { ...resolved, reference: secretId };
}

export function resolveValueRefPlaintext(params: Readonly<{
  valueRef: ValueRefV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  processEnv: NodeJS.ProcessEnv;
  session?: Readonly<{ sessionId: string; attestedContext?: SessionAttestedContextV1 }>;
  /** Owner-local diagnostics capture; values never leave the materialization lifetime. */
  onResolvedValue?: (value: string) => void;
}>): ValueRefPlaintextResolution {
  const ready = (value: string) => {
    params.onResolvedValue?.(value);
    return { status: 'ready' as const, value };
  };
  if (params.valueRef.t === 'sessionAttested') {
    const value = params.valueRef.field === 'sessionId' ? params.session?.sessionId
      : params.session?.attestedContext?.[params.valueRef.field];
    return typeof value === 'string' && value.length > 0
      ? ready(value) : { status: 'session_attested_unavailable' };
  }
  if (params.valueRef.t === 'literal') {
    const expanded = expandEnvironmentVariables({ __VALUE__: params.valueRef.v }, params.processEnv, {
      warnOnUndefined: false, onResolvedValue: params.onResolvedValue,
    })
      .__VALUE__;
    if (typeof expanded !== 'string') return { status: 'literal_unavailable' };
    if (params.valueRef.v.includes('${') && expanded.includes('${')) return { status: 'literal_unavailable' };
    return ready(expanded);
  }

  if (params.valueRef.t === 'template') {
    const vars = { ...params.valueRef.vars };
    for (const [name, variable] of Object.entries(vars)) {
      if (variable.t !== 'literal') continue;
      const expanded = resolveValueRefPlaintext({ ...params, valueRef: variable });
      if (expanded.status === 'ready') vars[name] = { t: 'literal', v: expanded.value };
      else delete vars[name];
    }
    let secretFailure: Exclude<ReturnType<typeof resolveSavedSecretValue>, { status: 'ready' }> | null = null;
    const value = resolveValueRefPlaintextV1({ ...params.valueRef, vars }, secretId => {
      const resolved = resolveSavedSecretValue(secretId, params.savedSecretMaterializer);
      if (resolved.status === 'ready') {
        params.onResolvedValue?.(resolved.value);
        return resolved.value;
      }
      secretFailure ??= resolved;
      return null;
    });
    if (secretFailure) return secretFailure;
    return value === null ? { status: 'literal_unavailable' } : ready(value);
  }

  const resolved = resolveSavedSecretValue(params.valueRef.secretId, params.savedSecretMaterializer);
  return resolved.status === 'ready' ? ready(resolved.value) : resolved;
}
