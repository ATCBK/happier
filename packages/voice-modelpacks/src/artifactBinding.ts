/**
 * Voice-owned correspondence between a public model-pack declaration and the
 * plugin artifact/custody fact that made it available to this daemon.
 *
 * `sourceIntegrity` deliberately preserves the acquisition owner's exact SRI
 * string. `materialization` records the durable source custody used for the
 * currently supported development path. Neither arm is a hash of extracted
 * plugin files or a process-local runtime occurrence.
 */
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { VoiceModelPackArtifactBindingV1Schema } from '@happier-dev/protocol/voice/modelPacks/artifactBindingV1';
import type { DevelopmentPluginSourceCustodyV1 } from '@happier-dev/protocol';

export type VoiceModelPackArtifactBindingV1 =
  | Readonly<{
      kind: 'sourceIntegrity';
      integrity: string;
    }>
  | Readonly<{
      kind: 'materialization';
      sourceCustody: DevelopmentPluginSourceCustodyV1;
    }>;

function invalid(): never {
  throw new Error('voice_model_pack_artifact_binding_invalid');
}

function readStrictRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalid();
  }
}

/** Strict input binding without canonicalizing source-owned SRI. */
export function parseVoiceModelPackArtifactBindingV1(value: unknown): VoiceModelPackArtifactBindingV1 {
  const record = readStrictRecord(value);
  const parsed = VoiceModelPackArtifactBindingV1Schema.safeParse(record);
  if (!parsed.success) return invalid();
  return freezeBinding(parsed.data);
}

function freezeBinding(binding: VoiceModelPackArtifactBindingV1): VoiceModelPackArtifactBindingV1 {
  if (binding.kind === 'sourceIntegrity') {
    return Object.freeze({
      kind: 'sourceIntegrity',
      integrity: binding.integrity,
    });
  }
  return Object.freeze({
    kind: 'materialization',
    sourceCustody: Object.freeze(binding.sourceCustody),
  });
}

export function voiceModelPackArtifactBindingsEqualV1(
  left: VoiceModelPackArtifactBindingV1,
  right: VoiceModelPackArtifactBindingV1,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'sourceIntegrity'
    ? right.kind === 'sourceIntegrity' && left.integrity === right.integrity
    : right.kind === 'materialization'
      && pluginSourceCustodyV1Equal(left.sourceCustody, right.sourceCustody);
}
